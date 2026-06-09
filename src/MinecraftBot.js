// Made by Ayliee, All rights are reserved to AeroX Development

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import mineflayer from 'mineflayer';
import { msg, msgSections } from './ui.js';

const FATAL_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']);
const INITIAL_RECONNECT_DELAY_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 5 * 60_000;
const ANTI_AFK_INTERVAL_MS = 5_000;
const MC_CHAT_LIMIT = 256;

// Local auth cache stored next to the bot files — works in any environment
// including headless servers and Pterodactyl containers (no Minecraft client needed)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MS_CACHE_DIR = path.join(__dirname, '..', 'auth-cache');
fs.mkdirSync(MS_CACHE_DIR, { recursive: true });

// Auth-plugin prompt patterns (AuthMe, nLogin, FastLogin, etc.)
const REGISTER_PATTERNS = [
  /\/register/i,
  /please register/i,
  /you must register/i,
  /register to (play|continue)/i,
  /use \/reg/i,
];
const LOGIN_PATTERNS = [
  /\/(login|l) /i,
  /please (log\s?in|authenticate)/i,
  /you must (log\s?in|authenticate)/i,
  /use \/log/i,
];

function extractText(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  let t = node.text || node.translate || '';
  if (Array.isArray(node.extra)) t += node.extra.map(extractText).join('');
  if (Array.isArray(node.with)) t += node.with.map(extractText).join('');
  return t;
}

function parseKickReason(reason) {
  try {
    return extractText(JSON.parse(reason)).trim() || reason;
  } catch {
    return reason;
  }
}

export class MinecraftBot {
  /**
   * @param {object}   options          mineflayer createBot options (host, port, username, auth)
   * @param {object}   discordChannel   Discord TextChannel to send status messages to
   * @param {Function} onFatal          called when the bot permanently fails and is removed
   * @param {Function} onRealUsername   called with the real MC username after first spawn
   * @param {string}   [authPassword]   optional stable password injected by BotManager (cracked bots)
   */
  constructor(options, discordChannel, onFatal, onRealUsername, authPassword) {
    this.options = options;
    this.discordChannel = discordChannel;
    this.onFatal = onFatal;
    this.onRealUsername = onRealUsername;
    this.bot = null;
    this.jumpInterval = null;
    this.lookInterval = null;
    this.reconnectTimeout = null;
    this.smpTimeout = null;
    this.smpJumpTimeout = null;
    this.isStopping = false;
    this.isFatal = false;
    this.isDisconnecting = false;
    this.reconnectAttempts = 0;
    this.spawnedOnce = false;
    this.realUsername = null;
    this.heartbeatInterval = null;
    this.lastPacketTime = null;

    // FIX: Accept an externally injected password from BotManager so that
    // a !leave + !join cycle on the same server reuses the original registered
    // password and AuthMe /login still succeeds.
    // Falls back to generating a fresh one only when BotManager doesn't supply one
    // (e.g. premium bots that don't need AuthMe registration).
    this.authPassword = authPassword || (Math.random().toString(36).slice(2, 12) + 'Aa1!');
  }

  // Safely send a V2 container message to Discord; swallows channel errors
  send(content) {
    this.discordChannel.send(content).catch(() => { });
  }

  // ─── Microsoft pre-authentication ────────────────────────────────────────────
  //
  // Bug (original): mineflayer opens the TCP connection to the Minecraft server
  // first, then waits for the server handshake before starting OAuth. If the
  // server is unreachable the error fires before onMsaCode is ever called —
  // the user never sees the login link and the bot is silently removed.
  //
  // Fix: call prismarine-auth directly BEFORE creating the mineflayer bot so the
  // OAuth flow (and Discord prompt) completes first. The token is then cached at
  // the EXACT same path that minecraft-protocol uses (nmp-cache inside the MC
  // folder), so mineflayer picks it up silently without a second OAuth prompt.
  //
  // On reconnect, if the cached token is still valid this is a near-instant no-op.
  // Expired refresh tokens (typically after 90 days) trigger a new OAuth prompt.
  async _preAuth() {
    try {
      // prismarine-auth is a CJS module — access module.exports via .default
      const { default: prismarineAuth } = await import('prismarine-auth');
      const { Authflow, Titles } = prismarineAuth;

      // Options must exactly match what minecraft-protocol's validateOptions() sets,
      // otherwise prismarine-auth writes to a different cache slot and mineflayer
      // won't find the token (triggering a duplicate OAuth prompt).
      const authOptions = {
        authTitle: Titles.MinecraftNintendoSwitch,
        deviceType: 'Nintendo',
        flow: 'live', // required — MicrosoftAuthFlow throws if omitted
      };

      const flow = new Authflow(
        this.options.username,  // Discord user ID — stable unique cache key
        MS_CACHE_DIR,           // same path as minecraft-protocol uses
        authOptions,
        (data) => {
          // Only called when a new login is actually needed (no valid cached token)
          const mins = Math.floor((data.expires_in || 900) / 60);
          const userIdentifier = this.options.username.startsWith('AFK_') ? this.options.username : `User (${this.options.username})`;
          this.send(
            msgSections(
              `🔑 **Microsoft Authentication Required**`,
              `To connect **${userIdentifier}** to **${this.options.host}**:\n\n1. Open: <${data.verification_uri}>\n2. Enter code: \`${data.user_code}\``,
              `-# ⏳ Expires in ${mins} minutes. The bot will join automatically after sign-in.`
            )
          );
        }
      );

      // Blocks until OAuth is complete or cached token is validated/refreshed.
      // fetchProfile: false — we only need the access token here; mineflayer
      // will fetch the profile itself when it connects.
      await flow.getMinecraftJavaToken({ fetchProfile: false });
      return true;

    } catch (err) {
      if (!this.isFatal && !this.isStopping) {
        this.isFatal = true;
        this.send(
          msg(`❌ **Authentication Failed**\nMicrosoft authentication failed for **${this.options.username}**.\n-# ⚠️ ${err.message || String(err)} · Bot removed from list.`)
        );
        if (this.onFatal) this.onFatal();
      }
      return false;
    }
  }

  // ─── Connection ───────────────────────────────────────────────────────────────

  async connect() {
    // FIX: Guard against connect() being called after stop() — e.g. if a
    // reconnect timer fires after an explicit !leave command races with it.
    if (this.isStopping || this.isFatal) return;

    this.isDisconnecting = false;

    // Remove all listeners from any previous bot instance before creating a new one.
    // Without this, stale listeners from the dead bot can fire spurious events after
    // reconnect (especially `error`), corrupting state.
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch { }
      this.bot = null;
    }

    // For Microsoft accounts: authenticate BEFORE opening the server connection.
    // Guarantees the OAuth prompt appears even if the server is unreachable.
    if (this.options.auth === 'microsoft') {
      const ok = await this._preAuth();
      if (!ok) return; // auth failed — fatal error already reported
    }

    // FIX: Re-check isStopping after the async _preAuth call — !leave may have
    // been called while waiting for OAuth to complete.
    if (this.isStopping || this.isFatal) return;

    // Token is now cached at MS_CACHE_DIR; mineflayer will read it silently.
    // No onMsaCode needed — the token is guaranteed to be present.
    const botOptions = {
      host: this.options.host,
      port: this.options.port || 25565,
      username: this.options.username,
      auth: this.options.auth || 'offline',
      version: this.options.version || false,
      hideErrors: true,
    };

    this.bot = mineflayer.createBot(botOptions);

    // Track last packet time to detect ghost connections
    this.bot.once('inject_allowed', () => {
      this.lastPacketTime = Date.now();
      this.bot._client.on('packet', () => {
        this.lastPacketTime = Date.now();
      });
    });

    this.bot.on('spawn', () => {
      // FIX: Guard — if stop() was called between createBot and spawn, abort
      if (this.isStopping || this.isFatal) return;

      this.reconnectAttempts = 0;
      this.isDisconnecting = false;
      const name = this.bot.username;
      this.realUsername = name;

      // Notify BotManager of the real MC username on the very first spawn
      if (!this.spawnedOnce && this.onRealUsername) {
        this.spawnedOnce = true;
        this.onRealUsername(name);
      }

      this.send(msg(`🟢 **Connected**\n**${name}** has successfully joined **${this.options.host}**.`));
      this.startAntiAfk();
      this.startHeartbeat();

      // Automatically send /smp after 15 seconds
      if (this.smpTimeout) clearTimeout(this.smpTimeout);
      this.smpTimeout = setTimeout(() => {
        if (this.bot && !this.isStopping) {
          this.bot.chat('/smp');
          this.send(msg(`🚀 **SMP Entered**\n**${name}** has entered the SMP server.`));
          
          if (this.smpJumpTimeout) clearTimeout(this.smpJumpTimeout);
          this.smpJumpTimeout = setTimeout(() => {
            if (this.bot && !this.isStopping) {
              this.jump();
            }
          }, 5000);

          // Wait 3 seconds for sub-server transition, then trigger callback to proceed queue
          setTimeout(() => {
            if (this.bot && !this.isStopping && typeof this.onSmpJoined === 'function') {
              this.onSmpJoined();
            }
          }, 3000);
        }
      }, 5_000);
    });

    // Intercept all server chat — catches AuthMe, nLogin, FastLogin prompts
    this.bot.on('messagestr', (raw) => {
      if (!this.bot || this.isStopping) return;
      const t = raw.toLowerCase();

      if (REGISTER_PATTERNS.some((p) => p.test(t))) {
        setTimeout(() => {
          if (this.bot && !this.isStopping)
            this.bot.chat(`/register ${this.authPassword} ${this.authPassword}`);
        }, 800);
        return;
      }

      if (LOGIN_PATTERNS.some((p) => p.test(t))) {
        setTimeout(() => {
          if (this.bot && !this.isStopping)
            this.bot.chat(`/login ${this.authPassword}`);
        }, 800);
      }
    });

    // Chat relay removed to prevent Minecraft chat forwarding to Discord

    this.bot.on('error', (err) => {
      if (this.isStopping || this.isFatal) return;
      if (FATAL_CODES.has(err.code)) {
        this.isFatal = true;
        const name = this.realUsername || this.options.username;
        this.send(
          msg(`⚠️ **Connection Error**\n**${name}** cannot reach **${this.options.host}**.\n-# 🔍 Reason: \`${err.code}\` · Bot removed from list.`)
        );
        this.stop();
        if (this.onFatal) this.onFatal();
      } else {
        console.warn(`[MinecraftBot] Non-fatal connection error: ${err.message || err.code}`);
        if (!this.isDisconnecting) {
          this.isDisconnecting = true;
          this.handleDisconnect();
        }
      }
    });

    this.bot.on('kicked', (reason) => {
      if (this.isStopping || this.isFatal || this.isDisconnecting) return;
      this.isDisconnecting = true;
      const name = this.bot?.username || this.realUsername || this.options.username;
      const readable = parseKickReason(reason);
      this.send(
        msgSections(
          `🟥 **Kicked from Server**\n**${name}** was kicked from **${this.options.host}**`,
          `> ${readable}`
        )
      );
      this.handleDisconnect();
    });

    // FIX: 'end' fires AFTER 'kicked' in mineflayer — original code checked
    // isDisconnecting but could still double-fire handleDisconnect if a kick
    // + end raced. Added isFatal guard to cover the error → stop() → end path.
    this.bot.on('end', () => {
      if (this.isStopping || this.isFatal || this.isDisconnecting) return;
      this.isDisconnecting = true;
      this.handleDisconnect();
    });
  }

  handleDisconnect() {
    if (this.isStopping || this.isFatal) return;
    this.stopAntiAfk();
    this.stopHeartbeat();

    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch { }
      this.bot = null;
    }

    const name = this.realUsername || this.options.username;
    this.reconnectAttempts++;

    // Exponential Backoff: double the delay each attempt, cap at MAX_RECONNECT_DELAY_MS
    const delayMs = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS
    );
    const delaySec = delayMs / 1000;

    this.send(
      msg(
        `🔄 **Reconnecting**\n**${name}** disconnected. Attempting to rejoin **${this.options.host}**...\n-# ⏳ Attempt #${this.reconnectAttempts} · Waiting ${delaySec}s before retrying`
      )
    );

    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => this.connect().catch(() => { }), delayMs);
  }

  startAntiAfk() {
    this.stopAntiAfk();

    // Rotate view every 30 seconds to simulate an active player
    this.lookInterval = setInterval(() => {
      if (this.bot?.entity) {
        const yaw = Math.random() * Math.PI * 2 - Math.PI;
        const pitch = (Math.random() - 0.5) * 1.0;
        this.bot.look(yaw, pitch, false);
      }
    }, 30_000);
  }

  stopAntiAfk() {
    if (this.lookInterval) { clearInterval(this.lookInterval); this.lookInterval = null; }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPacketTime = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (this.bot && this.lastPacketTime && (Date.now() - this.lastPacketTime > 60_000)) {
        const name = this.realUsername || this.options.username;
        this.send(
          msg(`👻 **Ghost Connection Detected**\n**${name}** hasn't received server packets for 60 seconds. Reconnecting to fix...`)
        );
        this.handleDisconnect();
      }
    }, 30_000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.lastPacketTime = null;
  }

  toggleAntiAfk(enable) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      this.send(msg(`**${name}** — not in-game, cannot toggle anti-AFK`));
      return;
    }
    const isRunning = !!(this.jumpInterval || this.lookInterval);
    // If enable is undefined → toggle; otherwise set explicitly
    const shouldEnable = enable === undefined ? !isRunning : enable;
    if (shouldEnable === isRunning) {
      this.send(msg(`**${name}** — anti-AFK is already **${isRunning ? 'on' : 'off'}**`));
      return;
    }
    if (shouldEnable) {
      this.startAntiAfk();
      this.send(msg(`⚙️ **Anti-AFK Enabled**\n**${name}** will now perform anti-AFK actions.`));
    } else {
      this.stopAntiAfk();
      this.send(msg(`⏸️ **Anti-AFK Disabled**\n**${name}** has stopped anti-AFK actions.`));
    }
  }

  jump() {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      this.send(msg(`**${name}** — not in-game, cannot jump`));
      return;
    }
    this.bot.setControlState('jump', true);
    setTimeout(() => { if (this.bot) this.bot.setControlState('jump', false); }, 400);
    this.send(msg(`🦘 **Action**\n**${name}** performed a jump.`));
  }

  say(text) {
    const name = this.realUsername || this.options.username;
    if (!this.bot?.entity) {
      this.send(msg(`**${name}** — not in-game, cannot send message`));
      return;
    }
    const truncated = text.length > MC_CHAT_LIMIT ? text.slice(0, MC_CHAT_LIMIT) : text;
    this.bot.chat(truncated);
    this.send(msg(`💬 **Chat Message Sent**\n**${name}**: ${truncated}`));
  }

  stop() {
    this.isStopping = true;
    this.stopAntiAfk();
    this.stopHeartbeat();
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    if (this.smpTimeout) clearTimeout(this.smpTimeout);
    if (this.smpJumpTimeout) clearTimeout(this.smpJumpTimeout);
    if (this.bot) {
      this.bot.removeAllListeners();
      try { this.bot.quit(); } catch { }
      this.bot = null;
    }
  }
}