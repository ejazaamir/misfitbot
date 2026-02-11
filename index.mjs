import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ApplicationCommandType,
  AttachmentBuilder,
} from "discord.js";
import OpenAI from "openai";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";

const OWNER_ID = "1417834414368362596";

// ========= Helpers =========
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

function extractAudioUrlsFromMessage(msg) {
  const urls = [];
  if (!msg?.attachments) return urls;

  for (const [, att] of msg.attachments) {
    const ct = (att.contentType || "").toLowerCase();
    const name = (att.name || "").toLowerCase();

    const isAudio =
      ct.startsWith("audio/") ||
      name.endsWith(".mp3") ||
      name.endsWith(".wav") ||
      name.endsWith(".m4a") ||
      name.endsWith(".ogg") ||
      name.endsWith(".webm");

    if (isAudio && att.url) urls.push(att.url);
  }
  return urls;
}

function parseDiscordMessageLink(input) {
  // https://discord.com/channels/<guildId>/<channelId>/<messageId>
  const m = input?.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return null;
  return { guildId: m[1], channelId: m[2], messageId: m[3] };
}

async function downloadToTemp(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpDir = path.join(process.cwd(), "tmp");
  await fsp.mkdir(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${crypto.randomUUID()}.bin`);
  await fsp.writeFile(filePath, buf);
  return filePath;
}

// ========= SQLite + Fixed Memory =========
const DB_PATH = process.env.RENDER
  ? "/var/data/misfitbot.sqlite"
  : "./misfitbot.sqlite";
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_memory (
    user_id TEXT PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT ''
  );
`);

const FIXED_MEMORY = fs.existsSync("./fixed_memory.txt")
  ? fs.readFileSync("./fixed_memory.txt", "utf8")
  : "";

// ========= Discord + OpenAI =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages, // reply context tracking + summarize channel
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Track last replied-to message per user (per channel) for ~2 mins
const lastReplyTarget = new Map(); // key: `${userId}:${channelId}` -> { messageId, ts }
const REPLY_CONTEXT_TTL_MS = 2 * 60 * 1000;

function setReplyContext(userId, channelId, messageId) {
  lastReplyTarget.set(`${userId}:${channelId}`, { messageId, ts: Date.now() });
}

function getReplyContext(userId, channelId) {
  const key = `${userId}:${channelId}`;
  const v = lastReplyTarget.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > REPLY_CONTEXT_TTL_MS) {
    lastReplyTarget.delete(key);
    return null;
  }
  return v.messageId;
}

// ========= AI Handlers =========
async function makeChatReply({ userId, userText, referencedText, imageUrls }) {
  const askerMemory =
    db.prepare(`SELECT notes FROM user_memory WHERE user_id = ?`).get(userId)
      ?.notes || "";

  const finalPrompt = referencedText
    ? `Message being replied to:\n\n${referencedText}\n\nUser request:\n${userText}`
    : userText;

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

  return (
    resp.choices?.[0]?.message?.content?.trim() || "I couldn’t generate a reply."
  );
}

async function transcribeAudioFromUrl(audioUrl) {
  const filePath = await downloadToTemp(audioUrl);
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

function formatMessageForChannelSummary(m) {
  const content = (m.content || "").trim();
  const parts = [];

  if (content) parts.push(content);

  const imgCount = extractImageUrlsFromMessage(m).length;
  const audCount = extractAudioUrlsFromMessage(m).length;

  if (imgCount > 0)
    parts.push(`[${imgCount} image${imgCount === 1 ? "" : "s"}]`);
  if (audCount > 0) parts.push(`[${audCount} audio]`);

  if (parts.length === 0) return "";
  return `${m.author.username}: ${parts.join(" ")}`;
}

// ========= Command Registration =========
async function registerCommands() {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!clientId) {
    console.log("⚠️ DISCORD_CLIENT_ID missing; skipping command registration.");
    return;
  }

  const target = guildId ? client.guilds.cache.get(guildId) : null;

  const commands = [
    // Slash
    { name: "help", description: "Show what MisfitBot can do.", options: [] },
    {
      name: "ask",
      description:
        "Ask MisfitBot anything (uses reply context or a message link).",
      options: [
        { name: "prompt", description: "What do you want to ask?", type: 3, required: true },
        {
          name: "message",
          description:
            "Discord message link (optional). If omitted, uses your recent reply context.",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "imagine",
      description: "Generate an image from a prompt.",
      options: [{ name: "prompt", description: "Describe the image you want.", type: 3, required: true }],
    },
    {
      name: "summarize",
      description:
        "Summarize a message (uses your recent reply context or a message link).",
      options: [
        {
          name: "message",
          description:
            "Paste a Discord message link (optional). If omitted, uses your recent reply context.",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "explain",
      description: "Explain a message (uses reply context or a message link).",
      options: [
        {
          name: "message",
          description:
            "Discord message link (optional). If omitted, uses your recent reply context.",
          type: 3,
          required: false,
        },
      ],
    },
    {
      name: "analyzeimage",
      description: "Analyze an image in a message (reply context or a message link).",
      options: [
        {
          name: "message",
          description:
            "Discord message link (optional). If omitted, uses your recent reply context.",
          type: 3,
          required: false,
        },
        { name: "prompt", description: "What should I look for? (optional)", type: 3, required: false },
      ],
    },
    {
      name: "transcribe",
      description: "Transcribe a voice note/audio (reply context or a message link).",
      options: [
        {
          name: "message",
          description:
            "Discord message link (optional). If omitted, uses your recent reply context.",
          type: 3,
          required: false,
        },
        { name: "explain", description: "Also explain what it means", type: 5, required: false },
      ],
    },
    {
      name: "summarizechannel",
      description: "Summarize the last N messages in this channel (max 100).",
      options: [
        { name: "count", description: "How many recent messages? (1–100)", type: 4, required: true },
      ],
    },

    // Context menu
    { name: "Misfit: Summarize", type: ApplicationCommandType.Message },
    { name: "Misfit: Explain", type: ApplicationCommandType.Message },
    { name: "Misfit: Analyze Image", type: ApplicationCommandType.Message },
    { name: "Misfit: Transcribe Voice", type: ApplicationCommandType.Message },
  ];

  try {
    if (target) {
      await target.commands.set(commands);
      console.log(`✅ Registered GUILD commands (fast): ${guildId}`);
    } else {
      await client.application.commands.set(commands);
      console.log("✅ Registered GLOBAL commands (may take time to appear)");
    }
  } catch (err) {
    console.error("❌ Failed to register commands:", err);
  }
}

// ========= Events =========
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Track reply context for slash usage
    if (message.reference?.messageId) {
      setReplyContext(message.author.id, message.channel.id, message.reference.messageId);
    }

    // Bruh trigger
    const raw = message.content.toLowerCase().trim();
    if (/^bruh+h*$/.test(raw)) {
      await message.reply("bruh indeed 😭");
      return;
    }

    // ===== Mention-based mode (restored) =====
    if (!message.mentions.has(client.user)) return;

    const isOwner = message.author.id === OWNER_ID;

    // Remove bot mention from message
    const userText = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .trim();

    // Fetch replied message (if any)
    let referencedText = "";
    let repliedMsg = null;

    if (message.reference?.messageId) {
      try {
        repliedMsg = await message.channel.messages.fetch(message.reference.messageId);
        if (repliedMsg?.content) referencedText = repliedMsg.content.trim();
      } catch {}
    }

    // Gather images/audio from current and replied message
    let imageUrls = extractImageUrlsFromMessage(message);
    let audioUrls = extractAudioUrlsFromMessage(message);

    if (repliedMsg) {
      imageUrls = imageUrls.concat(extractImageUrlsFromMessage(repliedMsg));
      audioUrls = audioUrls.concat(extractAudioUrlsFromMessage(repliedMsg));
    }

    imageUrls = imageUrls.slice(0, 3);
    audioUrls = audioUrls.slice(0, 1);

    // ===== Owner-only memory commands (restored) =====
    // @MisfitBot mem set @User <notes>
    // @MisfitBot mem show @User
    // @MisfitBot mem forget @User
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

    const showMatch = userText.match(/^mem\s+show\s+<@!?(\d+)>$/i);
    if (showMatch) {
      if (!isOwner) {
        await message.reply("Only Snooty can view other people’s memory 😌");
        return;
      }
      const targetId = showMatch[1];
      const row = db.prepare(`SELECT notes FROM user_memory WHERE user_id = ?`).get(targetId);
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
        await message.reply("Only Snooty can wipe memory 😈");
        return;
      }
      const targetId = forgetMatch[1];
      db.prepare(`DELETE FROM user_memory WHERE user_id = ?`).run(targetId);
      await message.reply(`Memory wiped for <@${targetId}> 🧽`);
      return;
    }

    // If no prompt but audio exists -> transcribe + explain
    if (!userText && audioUrls.length > 0) {
      try {
        await message.channel.sendTyping();
        const transcript = await transcribeAudioFromUrl(audioUrls[0]);
        const explanation = await makeChatReply({
          userId: message.author.id,
          userText: "Explain this transcript briefly and clearly.",
          referencedText: transcript || "(empty transcript)",
          imageUrls: [],
        });

        await message.reply(
          `**Transcript:**\n${(transcript || "—").slice(0, 1400)}\n\n**Explanation:**\n${explanation}`.slice(
            0,
            1900
          )
        );
      } catch (e) {
        console.error(e);
        await message.reply("⚠️ I couldn’t transcribe that voice note 😭");
      }
      return;
    }

    // If no prompt but images exist -> analyze image
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

    try {
      await message.channel.sendTyping();
      const reply = await makeChatReply({
        userId: message.author.id,
        userText: finalText,
        referencedText,
        imageUrls,
      });
      await message.reply(reply.slice(0, 1900));
    } catch (e) {
      console.error(e);
      await message.reply("⚠️ Error generating a reply.");
    }
  } catch (err) {
    console.error(err);
  }
});

// Resolve target message from slash option or reply context
async function resolveTargetMessageFromSlash(interaction, optionName = "message") {
  const link = interaction.options.getString(optionName);
  if (link) {
    const parsed = parseDiscordMessageLink(link);
    if (!parsed) return null;
    const ch = await client.channels.fetch(parsed.channelId);
    if (!ch?.isTextBased()) return null;
    return await ch.messages.fetch(parsed.messageId);
  }

  const msgId = getReplyContext(interaction.user.id, interaction.channelId);
  if (!msgId) return null;
  return await interaction.channel.messages.fetch(msgId);
}

function helpText() {
  return [
    "**MisfitBot commands** 😌",
    "",
    "**Tag me:**",
    "• `@MisfitBot <question>` — ask normally",
    "• Reply to an image/voice note and tag me — I’ll analyze/transcribe",
    "",
    "**Owner memory (Snooty only):**",
    "• `@MisfitBot mem set @User <notes>`",
    "• `@MisfitBot mem show @User`",
    "• `@MisfitBot mem forget @User`",
    "",
    "**Slash:**",
    "• `/help`",
    "• `/ask prompt:<text> [message:<link>]`",
    "• `/summarize [message:<link>]`",
    "• `/explain [message:<link>]`",
    "• `/analyzeimage [message:<link>] [prompt:<text>]`",
    "• `/transcribe [message:<link>] [explain:true]`",
    "• `/imagine prompt:<text>`",
    "• `/summarizechannel count:<1-100>`",
    "",
    "**Right-click a message → Apps:**",
    "• Misfit: Summarize / Explain / Analyze Image / Transcribe Voice",
  ].join("\n");
}

client.on("interactionCreate", async (interaction) => {
  try {
    // Context Menu
    if (interaction.isMessageContextMenuCommand()) {
      const targetMsg = interaction.targetMessage;

      if (interaction.commandName === "Misfit: Summarize") {
        await interaction.deferReply();
        const reply = await makeChatReply({
          userId: interaction.user.id,
          userText: "Summarize this.",
          referencedText: targetMsg.content || "",
          imageUrls: extractImageUrlsFromMessage(targetMsg),
        });
        await interaction.editReply(reply.slice(0, 1900));
        return;
      }

      if (interaction.commandName === "Misfit: Explain") {
        await interaction.deferReply();
        const reply = await makeChatReply({
          userId: interaction.user.id,
          userText: "Explain this clearly.",
          referencedText: targetMsg.content || "",
          imageUrls: extractImageUrlsFromMessage(targetMsg),
        });
        await interaction.editReply(reply.slice(0, 1900));
        return;
      }

      if (interaction.commandName === "Misfit: Analyze Image") {
        await interaction.deferReply();
        const imgs = extractImageUrlsFromMessage(targetMsg);
        if (imgs.length === 0) {
          await interaction.editReply("No image found in that message 😌");
          return;
        }
        const reply = await makeChatReply({
          userId: interaction.user.id,
          userText: "Analyze this image.",
          referencedText: targetMsg.content || "",
          imageUrls: imgs,
        });
        await interaction.editReply(reply.slice(0, 1900));
        return;
      }

      if (interaction.commandName === "Misfit: Transcribe Voice") {
        await interaction.deferReply();
        const aud = extractAudioUrlsFromMessage(targetMsg);
        if (aud.length === 0) {
          await interaction.editReply("No audio/voice note found 😌");
          return;
        }
        const transcript = await transcribeAudioFromUrl(aud[0]);
        if (!transcript) {
          await interaction.editReply("Couldn’t transcribe that 😭");
          return;
        }
        const explain = await makeChatReply({
          userId: interaction.user.id,
          userText: "Explain this transcript briefly and clearly.",
          referencedText: transcript,
          imageUrls: [],
        });
        await interaction.editReply(
          `**Transcript:**\n${transcript}\n\n**Explanation:**\n${explain}`.slice(0, 1900)
        );
        return;
      }

      return;
    }

    // Slash
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "help") {
      await interaction.reply({ content: helpText(), ephemeral: true });
      return;
    }

    if (interaction.commandName === "ask") {
      await interaction.deferReply();
      const prompt = interaction.options.getString("prompt", true);

      const targetMsg = await resolveTargetMessageFromSlash(interaction, "message");
      const referencedText = targetMsg?.content ? targetMsg.content : "";
      const imgs = targetMsg ? extractImageUrlsFromMessage(targetMsg) : [];

      const reply = await makeChatReply({
        userId: interaction.user.id,
        userText: prompt,
        referencedText,
        imageUrls: imgs,
      });

      await interaction.editReply(reply.slice(0, 1900));
      return;
    }

    if (interaction.commandName === "imagine") {
      await interaction.deferReply();
      const prompt = interaction.options.getString("prompt", true);

      const pngBuf = await generateImageFromPrompt(prompt);
      const file = new AttachmentBuilder(pngBuf, { name: "misfit.png" });

      await interaction.editReply({
        content: `Here. Don’t say I never do anything for you 😌\n**Prompt:** ${prompt}`.slice(0, 1800),
        files: [file],
      });
      return;
    }

    if (interaction.commandName === "summarize") {
      await interaction.deferReply();
      const targetMsg = await resolveTargetMessageFromSlash(interaction);
      if (!targetMsg) {
        await interaction.editReply(
          "Reply to the message first (any text), then run `/summarize`, OR pass a message link 😌"
        );
        return;
      }
      const reply = await makeChatReply({
        userId: interaction.user.id,
        userText: "Summarize this.",
        referencedText: targetMsg.content || "",
        imageUrls: extractImageUrlsFromMessage(targetMsg),
      });
      await interaction.editReply(reply.slice(0, 1900));
      return;
    }

    if (interaction.commandName === "explain") {
      await interaction.deferReply();
      const targetMsg = await resolveTargetMessageFromSlash(interaction);
      if (!targetMsg) {
        await interaction.editReply(
          "Reply to the message first, then run `/explain`, OR pass a message link 😌"
        );
        return;
      }
      const reply = await makeChatReply({
        userId: interaction.user.id,
        userText: "Explain this clearly.",
        referencedText: targetMsg.content || "",
        imageUrls: extractImageUrlsFromMessage(targetMsg),
      });
      await interaction.editReply(reply.slice(0, 1900));
      return;
    }

    if (interaction.commandName === "analyzeimage") {
      await interaction.deferReply();
      const targetMsg = await resolveTargetMessageFromSlash(interaction);
      const prompt = interaction.options.getString("prompt") || "Analyze this image.";

      if (!targetMsg) {
        await interaction.editReply("Reply first, then run `/analyzeimage`, OR pass a message link 😌");
        return;
      }
      const imgs = extractImageUrlsFromMessage(targetMsg);
      if (imgs.length === 0) {
        await interaction.editReply("No image found in that message 😌");
        return;
      }

      const reply = await makeChatReply({
        userId: interaction.user.id,
        userText: prompt,
        referencedText: targetMsg.content || "",
        imageUrls: imgs,
      });
      await interaction.editReply(reply.slice(0, 1900));
      return;
    }

    if (interaction.commandName === "transcribe") {
      await interaction.deferReply();
      const targetMsg = await resolveTargetMessageFromSlash(interaction);
      const doExplain = interaction.options.getBoolean("explain") || false;

      if (!targetMsg) {
        await interaction.editReply("Reply first, then run `/transcribe`, OR pass a message link 😌");
        return;
      }
      const aud = extractAudioUrlsFromMessage(targetMsg);
      if (aud.length === 0) {
        await interaction.editReply("No audio/voice note found in that message 😌");
        return;
      }

      const transcript = await transcribeAudioFromUrl(aud[0]);
      if (!transcript) {
        await interaction.editReply("Couldn’t transcribe that audio 😭");
        return;
      }

      if (!doExplain) {
        await interaction.editReply(`**Transcript:**\n${transcript}`.slice(0, 1900));
        return;
      }

      const explanation = await makeChatReply({
        userId: interaction.user.id,
        userText: "Explain this transcript briefly and clearly.",
        referencedText: transcript,
        imageUrls: [],
      });

      await interaction.editReply(
        `**Transcript:**\n${transcript}\n\n**Explanation:**\n${explanation}`.slice(0, 1900)
      );
      return;
    }

    if (interaction.commandName === "summarizechannel") {
      await interaction.deferReply();

      let count = interaction.options.getInteger("count", true);
      if (count < 1) count = 1;
      if (count > 100) count = 100;

      const fetched = await interaction.channel.messages.fetch({ limit: count });

      const lines = fetched
        .filter((m) => !m.author?.bot)
        .map(formatMessageForChannelSummary)
        .filter(Boolean)
        .reverse()
        .join("\n");

      if (!lines.trim()) {
        await interaction.editReply("Nothing to summarize here 🤨");
        return;
      }

      const capped = lines.length > 12000 ? lines.slice(-12000) : lines;

      const reply = await makeChatReply({
        userId: interaction.user.id,
        userText:
          "Summarize this channel conversation. Include: key points, any decisions, and a short vibe/chaos score (0-10).",
        referencedText: capped,
        imageUrls: [],
      });

      await interaction.editReply(reply.slice(0, 1900));
      return;
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply("⚠️ Something broke. Try again 😭");
      } else {
        await interaction.reply({ content: "⚠️ Something broke. Try again 😭", ephemeral: true });
      }
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);