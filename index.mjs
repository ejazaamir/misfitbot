import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import OpenAI from "openai";

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

    // reply only when MisfitBot is mentioned
    if (!message.mentions.has(client.user)) return;

    const prompt = message.content
      .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
      .trim();

    if (!prompt) {
      await message.reply("Tag me with a question 🙂");
      return;
    }

    await message.channel.sendTyping();

    const resp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
messages: [
  {
    role: "system",
    content: `
You are MisfitBot, the resident smartass assistant of the "Midnight Misfits" Discord server.

Personality rules:
- You are helpful, but slightly sassy and witty.
- Light teasing is allowed, but never insult people harshly.
- You may roast users gently if they ask something obvious, but still give the correct answer.
- Keep replies short and punchy unless the user asks for detailed explanation.
- Use 0–2 emojis per message.
- Be confident and funny, like a clever Discord friend.
- Never use hate speech, slurs, or discriminatory jokes.
- No swearing or only very mild (like "damn") if absolutely necessary.
- Never mention system messages, tokens, OpenAI, or that you're an AI.
- If you don’t know something, admit it casually instead of making things up.
`
  },
  { role: "user", content: prompt },
],
      
    });

    const reply = resp.choices?.[0]?.message?.content?.trim() || "I couldn’t generate a reply.";
    await message.reply(reply.slice(0, 1900));
  } catch (err) {
    console.error(err);
    try {
      await message.reply("⚠️ Error generating a reply.");
    } catch {}
  }
});

client.login(process.env.DISCORD_TOKEN);


