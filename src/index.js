// Made by Ayliee, All rights are reserved to AeroX Development

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
  msg,
  ContainerBuilder,
  MessageFlags,
  thinDivider,
  text,
} from './ui.js';
import { BotManager } from './BotManager.js';

// ─── Startup validation ────────────────────────────────────────────────────────

if (!process.env.DISCORD_TOKEN) {
  console.error('[ERROR] DISCORD_TOKEN is not set. Add it to your .env file or Pterodactyl startup variables.');
  process.exit(1);
}

const GUILD_ID = process.env.GUILD_ID?.trim() || null;
const DEFAULT_HOST = 'play.amorycraft.com';
const DEFAULT_PORT = 25565;

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const botManager = new BotManager();


client.on('clientReady', () => {
  if (GUILD_ID) {
    console.log(`Discord bot logged in as ${client.user.tag} — restricted to guild ${GUILD_ID}`);
  } else {
    console.log(`Discord bot logged in as ${client.user.tag} — active in all servers`);
  }
});

// ─── Help ─────────────────────────────────────────────────────────────────────

const COMMANDS = [
  { usage: '!join [username]', desc: 'Join the server.' },
  { usage: '!premjoin', desc: 'Join the server via Microsoft account.' },
  { usage: '!leave <username>', desc: 'Disconnect a bot.' },
  { usage: '!say <username> <message>', desc: 'Send a chat message in-game.' },
  { usage: '!bots', desc: 'List all active bots.' },
  { usage: '!jump <username>', desc: 'Force a bot to jump.' },
  { usage: '!afk <username> <on|off>', desc: 'Enable or disable anti-AFK.' },
  { usage: '!help', desc: 'Show this reference.' },
];

function buildHelp() {
  const c = new ContainerBuilder();

  c.addTextDisplayComponents(text('## MC AFK Bot Commands'));
  c.addSeparatorComponents(thinDivider());

  const commandLines = COMMANDS
    .map((cmd) => `\`${cmd.usage}\` **- ${cmd.desc}**`)
    .join('\n');

  c.addTextDisplayComponents(
    text(
      '**Send Minecraft AFK bots to any server and control them from Discord.**\n' +
      '\n' +
      '**Main Commands:**\n' +
      commandLines
    )
  );

  c.addSeparatorComponents(thinDivider());

  c.addTextDisplayComponents(
    text('**Made by:** Ayliee  ·  AeroX Development')
  );

  c.addSeparatorComponents(thinDivider());

  c.addTextDisplayComponents(
    text('-# Bots auto-jump every 5s and rotate view every 30s to prevent AFK kicks.')
  );

  return { components: [c], flags: MessageFlags.IsComponentsV2 };
}

// ─── Per-user command rate limiting ───────────────────────────────────────────
// FIX: No rate limiting existed — any user could spam commands to spawn bots.
// Simple cooldown map: userId → timestamp of last command.

const COOLDOWN_MS = 3_000; // 3 seconds between commands per user
const cooldowns = new Map();

function isRateLimited(userId) {
  const last = cooldowns.get(userId);
  const now = Date.now();
  if (last && now - last < COOLDOWN_MS) return true;
  cooldowns.set(userId, now);
  return false;
}

// ─── Username validation ───────────────────────────────────────────────────────
// FIX: No validation on cracked usernames — Minecraft usernames must be
// 3-16 chars, alphanumeric + underscores only. Invalid names cause mineflayer
// to fail silently or produce confusing errors.

const MC_USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

function isValidUsername(name) {
  return MC_USERNAME_RE.test(name);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  // Ignore bots, DMs, empty messages, and messages outside the configured guild
  if (message.author.bot) return;
  if (!message.guild) return;
  if (!message.content) return;
  if (GUILD_ID && message.guild.id !== GUILD_ID) return;

  const args = message.content.trim().split(/\s+/);
  const command = args[0].toLowerCase();

  // Only process known commands before rate-limit check to avoid wasting the
  // cooldown slot on unrelated messages
  const knownCommands = ['!help', '!join', '!premjoin', '!leave', '!say', '!bots', '!jump', '!afk'];
  if (!knownCommands.includes(command)) return;

  // FIX: Rate limit check — applied after command recognition
  if (isRateLimited(message.author.id)) {
    return message.reply(msg('-# Please wait a moment before sending another command.'));
  }

  // !help
  if (command === '!help') {
    return message.reply(buildHelp());
  }

  // !join [username]  —  cracked / offline-mode server
  if (command === '!join') {
    const username = args[1] || `AFK_${Math.floor(Math.random() * 9999)}`;

    // FIX: Validate username before attempting to connect
    if (!isValidUsername(username)) {
      return message.reply(msg(`invalid username **${username}**\n-# Must be 3-16 characters, letters/numbers/underscores only.`));
    }

    botManager.joinCracked({ host: DEFAULT_HOST, port: DEFAULT_PORT, username }, message.channel);
    return;
  }

  // !premjoin  —  online-mode server via Microsoft account
  if (command === '!premjoin') {
    botManager.joinPremium(message.author.id, { host: DEFAULT_HOST, port: DEFAULT_PORT }, message.channel);
    return;
  }

  // !leave <username>
  if (command === '!leave') {
    if (!args[1]) return message.reply(msg('usage: `!leave <username>`'));
    const username = args[1];
    botManager.removeBot(username, DEFAULT_HOST, message.channel);
    return;
  }

  // !say <username> <message...>
  if (command === '!say') {
    if (!args[1] || !args[2]) {
      return message.reply(msg('usage: `!say <username> <message>`'));
    }
    const username = args[1];
    const chatText = args.slice(2).join(' ');
    botManager.say(username, DEFAULT_HOST, chatText, message.channel);
    return;
  }

  // !bots
  if (command === '!bots') {
    return message.reply(botManager.getStatus());
  }

  // !jump <username>
  if (command === '!jump') {
    if (!args[1]) return message.reply(msg('usage: `!jump <username>`'));
    const username = args[1];
    botManager.jump(username, DEFAULT_HOST, message.channel);
    return;
  }

  // !afk <username> <on|off>
  if (command === '!afk') {
    if (!args[1] || !args[2]) {
      return message.reply(msg('usage: `!afk <username> <on|off>`'));
    }
    const username = args[1];
    const flag = args[2].toLowerCase();
    if (flag !== 'on' && flag !== 'off') {
      return message.reply(msg('usage: `!afk <username> <on|off>`\n-# Third argument must be `on` or `off`'));
    }
    botManager.toggleAntiAfk(username, DEFAULT_HOST, message.channel, flag === 'on');
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);