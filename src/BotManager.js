// Made by Ayliee, All rights are reserved to AeroX Development

import { MinecraftBot } from './MinecraftBot.js';
import { msg, msgList } from './ui.js';

export class BotManager {
  constructor() {
    // Map key format: "username@host" (post-spawn) or "msa:discordId@host" (pre-spawn premium)
    this.bots = new Map();

    // FIX: Persist authPasswords across bot removals/rejoins so AuthMe /login
    // still works after a !leave + !join cycle on the same server.
    // Key: "username@host", Value: password string
    this._authPasswords = new Map();
  }

  // Retrieve or create a stable auth password for this username+host pair.
  _getAuthPassword(username, host) {
    const key = `${username}@${host}`;
    if (!this._authPasswords.has(key)) {
      this._authPasswords.set(key, Math.random().toString(36).slice(2, 12) + 'Aa1!');
    }
    return this._authPasswords.get(key);
  }

  // Join a cracked (offline-mode) server — no account required
  joinCracked(options, channel) {
    const key = `${options.username}@${options.host}`;
    if (this.bots.has(key)) {
      return channel.send(msg(`**${options.username}** is already active on **${options.host}**`));
    }

    // FIX: Pass the stable persisted password into MinecraftBot instead of
    // letting it generate a new one — so rejoin after !leave reuses the same
    // password that was registered with AuthMe.
    const authPassword = this._getAuthPassword(options.username, options.host);

    const bot = new MinecraftBot(
      { ...options, auth: 'offline' },
      channel,
      () => this.bots.delete(key),
      null,
      authPassword
    );
    this.bots.set(key, bot);
    bot.connect().catch((err) => console.error('[BotManager] joinCracked connect error:', err));
  }

  // Join an online-mode (non-cracked) server via Microsoft account.
  // The Discord user ID is used as the stable prismarine-auth cache key,
  // so the user only needs to authenticate with Microsoft once.
  joinPremium(discordUserId, options, channel) {
    // FIX: Original duplicate check only compared options.username (discordUserId)
    // which works pre-spawn but fails post-spawn once the key has been re-keyed
    // to the real MC username (options.username never changes, but realUsername does).
    // Now we check BOTH to correctly detect duplicates at any lifecycle stage.
    const alreadyRunning = [...this.bots.values()].some(
      (b) =>
        b.options.host === options.host &&
        (
          // Pre-spawn: options.username is still the discordUserId
          b.options.username === discordUserId ||
          // Post-spawn: discordId stored separately on the bot instance
          b.discordUserId === discordUserId
        )
    );
    if (alreadyRunning) {
      return channel.send(msg(`You already have a premium bot on **${options.host}**`));
    }

    // Mutable closure key — starts as pending, updated to real MC username after spawn
    let currentKey = `msa:${discordUserId}@${options.host}`;

    const bot = new MinecraftBot(
      { ...options, username: discordUserId, auth: 'microsoft' },
      channel,
      // onFatal: clean up whichever key is current at the time of fatal failure
      () => this.bots.delete(currentKey),
      // onRealUsername: re-key the map entry under the real MC username
      (realUsername) => {
        this.bots.delete(currentKey);
        currentKey = `${realUsername}@${options.host}`;
        this.bots.set(currentKey, bot);
      }
    );

    // FIX: Store discordUserId on the bot instance so the duplicate check above
    // can find it after the key has been re-keyed to the real MC username.
    bot.discordUserId = discordUserId;

    this.bots.set(currentKey, bot);
    bot.connect().catch((err) => console.error('[BotManager] joinPremium connect error:', err));
  }

  // Disconnect and remove a bot by username + host.
  // Handles three cases:
  //   1. Normal offline bot:          key = "username@host"
  //   2. Premium bot post-spawn:      key = "realMcUsername@host"
  //   3. Premium bot pre-spawn:       key = "msa:discordId@host"
  //      → Linear scan matches on realUsername or options.username
  removeBot(username, host, channel) {
    // Case 1 & 2: direct key lookup (fastest path)
    const exactKey = `${username}@${host}`;
    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).stop();
      this.bots.delete(exactKey);
      return channel.send(msg(`**${username}** disconnected from **${host}**`));
    }

    // Case 3: pre-spawn premium bot — key is "msa:discordId@host", not known to user.
    // Scan all bots and match on host + whichever username field is set.
    for (const [key, bot] of this.bots.entries()) {
      if (
        bot.options.host === host &&
        (bot.realUsername === username || bot.options.username === username)
      ) {
        bot.stop();
        this.bots.delete(key);
        return channel.send(msg(`**${username}** disconnected from **${host}**`));
      }
    }

    return channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  // Force a bot to jump, identified by username + host.
  jump(username, host, channel) {
    const exactKey = `${username}@${host}`;
    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).jump();
      return;
    }

    for (const bot of this.bots.values()) {
      if (
        bot.options.host === host &&
        (bot.realUsername === username || bot.options.username === username)
      ) {
        bot.jump();
        return;
      }
    }

    channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  // FIX: say() now requires host parameter to correctly identify the bot when
  // the same username exists on multiple servers. Signature changed from
  // say(username, text, channel) → say(username, host, text, channel).
  say(username, host, text, channel) {
    // Direct key lookup first (fastest, unambiguous)
    const exactKey = `${username}@${host}`;
    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).say(text);
      return;
    }

    // Fallback: scan for pre-spawn premium bots or bots matched by realUsername
    for (const bot of this.bots.values()) {
      if (
        bot.options.host === host &&
        (bot.realUsername === username || bot.options.username === username)
      ) {
        bot.say(text);
        return;
      }
    }

    channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  // Toggle anti-AFK for a bot by username + host.
  // enable: true = force on, false = force off, undefined = toggle
  toggleAntiAfk(username, host, channel, enable) {
    const exactKey = `${username}@${host}`;
    if (this.bots.has(exactKey)) {
      this.bots.get(exactKey).toggleAntiAfk(enable);
      return;
    }
    for (const bot of this.bots.values()) {
      if (
        bot.options.host === host &&
        (bot.realUsername === username || bot.options.username === username)
      ) {
        bot.toggleAntiAfk(enable);
        return;
      }
    }
    channel.send(msg(`no bot named **${username}** on **${host}**`));
  }

  // Return a V2 message listing all active bots and their state
  getStatus() {
    if (this.bots.size === 0) {
      return msg('no active bots');
    }

    const rows = [...this.bots.values()].map((bot) => {
      const name = bot.realUsername || bot.options.username;
      const state = bot.bot?.entity ? 'online' : 'connecting';
      return `**${name}** — ${bot.options.host}:${bot.options.port} — ${state}`;
    });

    const count = rows.length;
    return msgList(
      '**Active Bots**',
      rows,
      `-# ${count} bot${count === 1 ? '' : 's'} running`
    );
  }
}