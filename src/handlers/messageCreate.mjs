import { AttachmentBuilder } from "discord.js";

export function registerMessageCreateHandler({
  client,
  OWNER_ID,
  db,
  setUserMemory,
  clearUserMemory,
  ai,
  extractImageUrlsFromMessage,
  extractAudioAttachmentsFromMessage,
  setReplyContext,
}) {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author.bot) return;

      if (message.reference?.messageId) {
        setReplyContext(
          message.author.id,
          message.channel.id,
          message.reference.messageId
        );
      }

      const raw = message.content.toLowerCase().trim();
      if (/^bruh+h*$/.test(raw)) {
        await message.reply("bruh indeed 😭");
        return;
      }

      if (!message.mentions.has(client.user)) return;

      const isOwner = message.author.id === OWNER_ID;

      const userText = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim();

      let referencedText = "";
      let repliedMsg = null;

      if (message.reference?.messageId) {
        try {
          repliedMsg = await message.channel.messages.fetch(
            message.reference.messageId
          );
          if (repliedMsg?.content) referencedText = repliedMsg.content.trim();
        } catch {}
      }

      let imageUrls = extractImageUrlsFromMessage(message);
      let audioAtts = extractAudioAttachmentsFromMessage(message);

      if (repliedMsg) {
        imageUrls = imageUrls.concat(extractImageUrlsFromMessage(repliedMsg));
        audioAtts = audioAtts.concat(
          extractAudioAttachmentsFromMessage(repliedMsg)
        );
      }

      imageUrls = imageUrls.slice(0, 3);
      audioAtts = audioAtts.slice(0, 1);

      const setMatch = userText.match(/^mem\s+set\s+<@!?(\d+)>\s+(.+)$/i);
      if (setMatch) {
        if (!isOwner) {
          return void (await message.reply(
            "Nice try. Only Snooty can edit memory 😌"
          ));
        }
        const targetId = setMatch[1];
        const notes = setMatch[2].trim();

        setUserMemory(targetId, notes);

        await message.reply(`Got it. I’ll remember that about <@${targetId}> 🧠`);
        return;
      }

      const showMatch = userText.match(/^mem\s+show\s+<@!?(\d+)>$/i);
      if (showMatch) {
        if (!isOwner) {
          return void (await message.reply(
            "Only Snooty can view other people’s memory 😌"
          ));
        }
        const targetId = showMatch[1];
        const row = db
          .prepare(`SELECT notes FROM user_memory WHERE user_id = ?`)
          .get(targetId);
        await message.reply(
          row?.notes
            ? `Memory for <@${targetId}>:\n${row.notes}`
            : `I have nothing stored for <@${targetId}> yet.`
        );
        return;
      }

      const forgetMatch = userText.match(/^mem\s+forget\s+<@!?(\d+)>$/i);
      if (forgetMatch) {
        if (!isOwner) {
          return void (await message.reply("Only Snooty can wipe memory 😈"));
        }
        const targetId = forgetMatch[1];
        clearUserMemory(targetId);
        await message.reply(`Memory wiped for <@${targetId}> 🧽`);
        return;
      }

      const voiceFromReplyMatch = userText.match(
        /^voice(?:\s*note)?(?:\s+(alloy|nova|onyx|echo|fable|shimmer))?$/i
      );
      if (voiceFromReplyMatch && repliedMsg) {
        const text = (repliedMsg.content || "").trim();
        if (!text) {
          await message.reply("That replied message has no text to read 😌");
          return;
        }

        const voice = (voiceFromReplyMatch[1] || "alloy").toLowerCase();
        await message.channel.sendTyping();
        try {
          const mp3Buf = await ai.generateVoiceFromText(text, voice);
          const file = new AttachmentBuilder(mp3Buf, {
            name: "misfit-voicenote.mp3",
          });
          await message.reply({
            content: `🎙️ Voice note ready (${voice}).`,
            files: [file],
          });
        } catch (e) {
          console.error("Voice note (mention/reply) failed:", e);
          await message.reply("⚠️ I couldn’t generate that voice note 😭");
        }
        return;
      }

      if (!userText && audioAtts.length > 0) {
        await message.channel.sendTyping();
        try {
          const transcript = await ai.transcribeAudioAttachment(audioAtts[0]);
          const explanation = await ai.makeChatReply({
            userId: message.author.id,
            userText: "Explain this transcript briefly and clearly.",
            referencedText: transcript || "(empty transcript)",
            imageUrls: [],
          });

          await message.reply(
            `**Transcript:**\n${(transcript || "—").slice(
              0,
              1400
            )}\n\n**Explanation:**\n${explanation}`.slice(0, 1900)
          );
        } catch (e) {
          console.error("Transcribe (mention) failed:", e);
          await message.reply("⚠️ I couldn’t transcribe that voice note 😭");
        }
        return;
      }

      const finalText =
        userText && userText.length > 0
          ? userText
          : imageUrls.length > 0
            ? "Analyze this image."
            : "";

      if (!finalText) {
        await message.reply("Tag me with a question 😌");
        return;
      }

      await message.channel.sendTyping();
      try {
        const reply = await ai.makeChatReply({
          userId: message.author.id,
          userText: finalText,
          referencedText,
          imageUrls,
        });
        await message.reply(reply.slice(0, 1900));
      } catch (e) {
        console.error("Chat (mention) failed:", e);
        await message.reply("⚠️ Error generating a reply.");
      }
    } catch (err) {
      console.error(err);
    }
  });
}
