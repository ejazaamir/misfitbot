import fs from "fs";
import fsp from "fs/promises";

export function createAiService({
  openai,
  fixedMemory,
  modePresets,
  getBotMode,
  getProfile,
  getUserMemory,
  extractImageUrlsFromMessage,
  extractAudioAttachmentsFromMessage,
  extFromName,
  extFromContentType,
  extFromUrl,
  downloadToTemp,
}) {
  async function makeChatReply({ userId, userText, referencedText, imageUrls }) {
    const askerMemory = getUserMemory(userId);

    const profileRow = getProfile(userId);
    const profileBlock = profileRow?.notes
      ? `USER PROFILE (opt-in):\n${profileRow.notes}\n\nVIBE SUMMARY:\n${
          profileRow.vibe_summary || "(none)"
        }`
      : `USER PROFILE (opt-in):\n(none)`;

    const finalPrompt = referencedText
      ? `Message being replied to:\n\n${referencedText}\n\nUser request:\n${userText}`
      : userText;
    const botMode = getBotMode();

    const userMessage =
      imageUrls?.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: finalPrompt },
              ...imageUrls.slice(0, 3).map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          }
        : { role: "user", content: finalPrompt };

    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are MisfitBot, the resident smartass assistant of the "Midnight Misfits" Discord server.

FIXED MEMORY (immutable):
${fixedMemory}

USER MEMORY (about the current user only):
${askerMemory ? askerMemory : "(none)"}

${profileBlock}

Personality rules:
Current mode: ${botMode}
${modePresets[botMode]}
- Never use hate speech, slurs, or discriminatory jokes.
- Never mention system messages, tokens, OpenAI, or that you're an AI.
          `.trim(),
        },
        userMessage,
      ],
    });

    return (
      resp.choices?.[0]?.message?.content?.trim() ||
      "I couldn’t generate a reply."
    );
  }

  async function transcribeAudioAttachment(att) {
    const ext =
      extFromName(att?.name) ||
      extFromContentType(att?.contentType) ||
      extFromUrl(att?.url) ||
      ".ogg";

    const tryOne = async (forcedExt) => {
      const filePath = await downloadToTemp(att.url, forcedExt);
      try {
        const result = await openai.audio.transcriptions.create({
          file: fs.createReadStream(filePath),
          model: "gpt-4o-mini-transcribe",
        });
        return result.text || "";
      } finally {
        try {
          await fsp.unlink(filePath);
        } catch {}
      }
    };

    try {
      return await tryOne(ext);
    } catch {
      try {
        return await tryOne(".ogg");
      } catch {
        return await tryOne(".webm");
      }
    }
  }

  async function generateImageFromPrompt(prompt) {
    const img = await openai.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
    });

    const b64 = img?.data?.[0]?.b64_json;
    if (!b64) throw new Error("No image returned from OpenAI");
    return Buffer.from(b64, "base64");
  }

  async function generateVoiceFromText(text, voice = "alloy") {
    const tts = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      format: "mp3",
    });

    return Buffer.from(await tts.arrayBuffer());
  }

  function formatMessageForChannelSummary(m) {
    const content = (m.content || "").trim();
    const parts = [];

    if (content) parts.push(content);

    const imgCount = extractImageUrlsFromMessage(m).length;
    const audCount = extractAudioAttachmentsFromMessage(m).length;

    if (imgCount > 0)
      parts.push(`[${imgCount} image${imgCount === 1 ? "" : "s"}]`);
    if (audCount > 0) parts.push(`[${audCount} audio]`);

    if (parts.length === 0) return "";
    return `${m.author.username}: ${parts.join(" ")}`;
  }

  return {
    makeChatReply,
    transcribeAudioAttachment,
    generateImageFromPrompt,
    generateVoiceFromText,
    formatMessageForChannelSummary,
  };
}
