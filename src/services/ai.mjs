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
  const TIMEZONE_ALIASES = new Map([
    ["utc", "UTC"],
    ["gmt", "UTC"],
    ["singapore", "Asia/Singapore"],
    ["sg", "Asia/Singapore"],
    ["india", "Asia/Kolkata"],
    ["ist", "Asia/Kolkata"],
    ["dubai", "Asia/Dubai"],
    ["uae", "Asia/Dubai"],
    ["london", "Europe/London"],
    ["uk", "Europe/London"],
    ["paris", "Europe/Paris"],
    ["berlin", "Europe/Berlin"],
    ["tokyo", "Asia/Tokyo"],
    ["japan", "Asia/Tokyo"],
    ["seoul", "Asia/Seoul"],
    ["sydney", "Australia/Sydney"],
    ["new york", "America/New_York"],
    ["nyc", "America/New_York"],
    ["los angeles", "America/Los_Angeles"],
    ["la", "America/Los_Angeles"],
    ["chicago", "America/Chicago"],
    ["toronto", "America/Toronto"],
  ]);

  function looksLikeTimeQuestion(input) {
    const s = String(input || "").toLowerCase();
    return (
      /\bwhat(?:'s| is)?\s+the?\s*time\b/.test(s) ||
      /\btime\s+is\s+it\b/.test(s) ||
      /\bcurrent\s+time\b/.test(s) ||
      /\btime\s+now\b/.test(s)
    );
  }

  function findTimezoneFromText(input) {
    const raw = String(input || "").trim();
    if (!raw) return null;
    const clean = raw
      .toLowerCase()
      .replace(/[?.,!]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const inMatch = clean.match(/\bin\s+([a-z/_ ]{2,40})$/i);
    const candidate = (inMatch ? inMatch[1] : clean).trim();
    if (!candidate) return null;

    if (TIMEZONE_ALIASES.has(candidate)) {
      return TIMEZONE_ALIASES.get(candidate);
    }

    const maybeIana = candidate
      .split(" ")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("_")
      .replace(/_/g, "/");

    try {
      new Intl.DateTimeFormat("en-US", { timeZone: maybeIana }).format(new Date());
      return maybeIana;
    } catch {
      return null;
    }
  }

  function formatNowForTimeZone(timeZone) {
    const now = new Date();
    const text = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(now);
    return { now, text };
  }

  function getLiveTimeReply(input) {
    if (!looksLikeTimeQuestion(input)) return null;

    const tz = findTimezoneFromText(input);
    if (tz) {
      const { text } = formatNowForTimeZone(tz);
      return `Current time in **${tz}**: **${text}**.`;
    }

    const utc = formatNowForTimeZone("UTC").text;
    return `Current time in **UTC**: **${utc}**. If you want another location, ask like: \`what time is it in Singapore?\``;
  }

  async function makeChatReply({ userId, userText, referencedText, imageUrls }) {
    const directTimeReply = getLiveTimeReply(userText);
    if (directTimeReply && !referencedText && (!imageUrls || imageUrls.length === 0)) {
      return directTimeReply;
    }

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
    const now = new Date();
    const nowUnix = Math.floor(now.getTime() / 1000);
    const nowUtcIso = now.toISOString();

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
Time rules:
- You DO have a trusted live clock in this prompt.
- Current UTC time is ${nowUtcIso} (unix ${nowUnix}).
- If asked for time/date, use this clock and convert timezone explicitly.
- Never claim you cannot access real-time time.
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
