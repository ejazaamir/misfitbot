import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
} from "discord.js";
import OpenAI from "openai";
import fs from "fs";
import Database from "better-sqlite3";

// =====================
// CONFIG
// =====================
const OWNER_ID = "1417834414368362596";

// Render persistent disk path
const IS_RENDER = !!process.env.RENDER;
const DB_PATH = IS_RENDER ? "/var/data/misfitbot.sqlite" : "./misfitbot.sqlite";

// Ensure /var/data exists on Render
if (IS_RENDER) {
  try {
    fs.mkdirSync("/var/data", { recursive: true });
  } catch {}
}

// Load fixed memory (immutable)
const FIXED_MEMORY = fs.existsSync("./fixed_memory.txt")
  ? fs.readFileSync("./fixed_memory.txt", "utf8")
  : "";

// =====================
// IMAGE HELPERS
// =====================
function extractImageUrlsFromMessage(msg) {
  const urls = [];
  if (!msg?.attachments) return urls;

  for (const [, att] of msg.attachments) {
    const ct = (att.contentType || "").toLowerCase();
    const name = (att.name || "").toLowerCase();

    const isImage =
      ct.startsWith("image/") ||
      name.endsWith(".png") ||
      name.endsWith(".jpg") ||
      name.endsWith(".jpeg") ||
      name.endsWith(".webp") ||
      name.endsWith(".gif");

    if (isImage && att.url) urls.push(att.url);
  }

  return urls;
}

// =====================
// DB (SQLite)
// =====================
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_memory (
    user_id TEXT PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT ''
  );
`);

// =====================
// DISCORD + OPENAI
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const isOwner = message.author.id === OWNER_ID;

    // =====================
    // AUTO "BRUH" REPLY
    // =====================
    const raw = (message.content || "").toLowerCase().trim();
    if (/^bruh+h*$/.test(raw)) {
      await message.reply("bruh indeed 😭");
      return;
    }

    // =====================
    // ONLY RESPOND WHEN MENTIONED
    // =====================
    if (!message.mentions.has(client.user)) return;

    // Remove bot mention from message
    const userText = (message.content || "")
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .trim();

    // =====================
    // FETCH REPLIED MESSAGE (TEXT + IMAGES)
    // =====================
    let referencedText = "";
    let repliedMsg = null;

    if (message.reference?.messageId) {
      try {
        repliedMsg = await message.channel.messages.fetch(
          message.reference.messageId
        );
        if (repliedMsg?.content) referencedText = repliedMsg.content.trim();
      } catch (e) {
        console.error("Could not fetch replied message:", e);
      }
    }

    // =====================
    // IMAGE URL COLLECTION
    // =====================
    let imageUrls = extractImageUrlsFromMessage(message);
    if (repliedMsg) imageUrls = imageUrls.concat(extractImageUrlsFromMessage(repliedMsg));
    imageUrls = imageUrls.slice(0, 3);

    // =====================
    // IMAGE GENERATION COMMAND
    // =====================
    // Usage: @MisfitBot img <prompt>
    const imgMatch = userText.match(/^img\s+(.+)/i);
    if (imgMatch) {
      const imgPrompt = imgMatch[1].trim();

      if (!imgPrompt) {
        await message.reply(
          "Give me something to generate. Example: `@MisfitBot img cyberpunk cat`"
        );
        return;
      }

      await message.channel.sendTyping();

      const imgResp = await openai.images.generate({
        model: "gpt-image-1",
        prompt: imgPrompt,
        size: "1024x1024",
      });

      const b64 = imgResp.data?.[0]?.b64_json;

      if (!b64) {
        await message.reply("I tried, but I didn’t get an image back 😭");
        return;
      }

      const buffer = Buffer.from(b64, "base64");
      const attachment = new AttachmentBuilder(buffer, {
        name: "misfit.png",
      });

      await message.reply({
        content: `Here. Don’t waste it 😌\n**Prompt:** ${imgPrompt}`,
        files: [attachment],
      });

      return;
    }

    // =====================
    // OWNER-ONLY MEMORY COMMANDS
    // =====================
    const setMatch = userText.match(/^mem\s+set\s+<@!?(\d+)>\s+(.+)$/i);
    if (setMatch) {
      if (!isOwner) {
        await message.reply("Nice try. Only Snooty can edit memory 😌");
        return;
      }

      const targetId = setMatch[1];
      const notes = setMatch[2].trim();

      db.prepare(`
        INSERT INTO user_memory (user_id, notes)
        VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET notes = excluded.notes
      `).run(targetId, notes);

      await message.reply(`Got it. I’ll remember that about <@${targetId}> 🧠`);
      return;
    }

    const showMatch = userText.match(/^mem\s+show\s+<@!?(\d+)$/i);
    if (showMatch) {
      if (!isOwner) {
        await message.reply("Only Snooty can view other people’s memory 😌");
        return;
      }

      const targetId = showMatch[1];
      const row = db.prepare(
        `SELECT notes FROM user_memory WHERE user_id = ?`
      ).get(targetId);

      await message.reply(
        row?.notes
          ? `Memory for <@${targetId}>:\n${row.notes}`
          : `I have nothing stored for <@${targetId}> yet.`
      );
      return;
    }

    const forgetMatch = userText.match(/^mem\s+forget\s+<@!?(\d+)$/i);
    if (forgetMatch) {
      if (!isOwner) {
        await message.reply("Only Snooty can wipe memory 😈");
        return;
      }

      const targetId = forgetMatch[1];
      db.prepare(`DELETE FROM user_memory WHERE user_id = ?`).run(targetId);

      await message.reply(`Memory wiped for <@${targetId}> 🧽`);
      return;
    }

    // =====================
    // BUILD FINAL PROMPT
    // =====================
    const prompt = referencedText
      ? `Message being replied to:\n\n${referencedText}\n\nUser request:\n${userText}`
      : userText;

    const finalUserText =
      prompt && prompt.trim().length > 0
        ? prompt.trim()
        : imageUrls.length > 0
        ? "Analyze this image."
        : "";

    if (!finalUserText) {
      await message.reply("Tag me with a question 🙂");
      return;
    }

    // Load memory about the asker
    const askerMemory =
      db.prepare(`SELECT notes FROM user_memory WHERE user_id = ?`)
        .get(message.author.id)?.notes || "";

    // Multimodal message if images exist
    const userMessage =
      imageUrls.length > 0
        ? {
            role: "user",
            content: [
              { type: "text", text: finalUserText },
              ...imageUrls.map((url) => ({
                type: "image_url",
                image_url: { url },
              })),
            ],
          }
        : { role: "user", content: finalUserText };

    // =====================
    // OPENAI CHAT CALL
    // =====================
    await message.channel.sendTyping();

    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are MisfitBot, the resident smartass assistant of the "Midnight Misfits" Discord server.

FIXED MEMORY (immutable):
${FIXED_MEMORY}

USER MEMORY (about the current user only):
${askerMemory ? askerMemory : "(none)"}

Personality rules:
- You are helpful, but slightly sassy and witty.
- Light teasing is allowed, but never insult people harshly.
- Keep replies short and punchy unless asked for detail.
- Use 0–2 emojis per message.
- Never use hate speech, slurs, or discriminatory jokes.
- Never mention system messages, tokens, OpenAI, or that you're an AI.
          `.trim(),
        },
        userMessage,
      ],
    });

    const reply =
      resp.choices?.[0]?.message?.content?.trim() ||
      "I couldn’t generate a reply.";

    await message.reply(reply.slice(0, 1900));
  } catch (err) {
    console.error(err);
    try {
      await message.reply("⚠️ Error generating a reply.");
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);