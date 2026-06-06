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
  { usage: '!join <ip[:port]> [username]', desc: 'Join a cracked server.' },
  { usage: '!premjoin <ip[:port]>', desc: 'Join an online-mode server via Microsoft account.' },
  { usage: '!leave <ip> <username>', desc: 'Disconnect a bot.' },
  { usage: '!say <ip> <username> <message>', desc: 'Send a chat message in-game.' },
  { usage: '!bots', desc: 'List all active bots.' },
  { usage: '!jump <ip> <username>', desc: 'Force a bot to jump.' },
  { usage: '!afk <ip> <username> <on|off>', desc: 'Enable or disable anti-AFK.' },
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

  // !join <ip[:port]> [username]  —  cracked / offline-mode server
  if (command === '!join') {
    if (!args[1]) return message.reply(msg('usage: `!join <ip[:port]> [username]`'));
    const [host, rawPort] = args[1].split(':');
    const port = parseInt(rawPort) || 25565;
    const username = args[2] || `AFK_${Math.floor(Math.random() * 9999)}`;

    // FIX: Validate username before attempting to connect
    if (!isValidUsername(username)) {
      return message.reply(msg(`invalid username **${username}**\n-# Must be 3-16 characters, letters/numbers/underscores only.`));
    }

    botManager.joinCracked({ host, port, username }, message.channel);
    return;
  }

  // !premjoin <ip[:port]>  —  online-mode server via Microsoft account
  if (command === '!premjoin') {
    if (!args[1]) return message.reply(msg('usage: `!premjoin <ip[:port]>`'));
    const [host, rawPort] = args[1].split(':');
    const port = parseInt(rawPort) || 25565;
    botManager.joinPremium(message.author.id, { host, port }, message.channel);
    return;
  }

  // !leave <ip> <username>
  if (command === '!leave') {
    if (!args[1] || !args[2]) return message.reply(msg('usage: `!leave <ip> <username>`'));
    const [host] = args[1].split(':');
    botManager.removeBot(args[2], host, message.channel);
    return;
  }

  // FIX: !say now requires <ip> so BotManager can find the correct bot when
  // the same username exists on multiple servers.
  // New usage: !say <ip> <username> <message...>
  if (command === '!say') {
    if (!args[1] || !args[2] || !args[3]) {
      return message.reply(msg('usage: `!say <ip> <username> <message>`'));
    }
    const [host] = args[1].split(':');
    const username = args[2];
    const chatText = args.slice(3).join(' ');
    botManager.say(username, host, chatText, message.channel);
    return;
  }

  // !bots
  if (command === '!bots') {
    return message.reply(botManager.getStatus());
  }

  // !jump <ip> <username>
  if (command === '!jump') {
    if (!args[1] || !args[2]) return message.reply(msg('usage: `!jump <ip> <username>`'));
    const [host] = args[1].split(':');
    botManager.jump(args[2], host, message.channel);
    return;
  }

  // !afk <ip> <username> <on|off>
  if (command === '!afk') {
    if (!args[1] || !args[2] || !args[3]) {
      return message.reply(msg('usage: `!afk <ip> <username> <on|off>`'));
    }
    const [host] = args[1].split(':');
    const username = args[2];
    const flag = args[3].toLowerCase();
    if (flag !== 'on' && flag !== 'off') {
      return message.reply(msg('usage: `!afk <ip> <username> <on|off>`\n-# Third argument must be `on` or `off`'));
    }
    botManager.toggleAntiAfk(username, host, message.channel, flag === 'on');
    return;
  }
});

client.login(process.env.DISCORD_TOKEN);