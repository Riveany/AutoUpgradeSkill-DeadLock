/*
 * Build Auto-Level for Deadlock - v0.1-dev
 * (development fork of Build Auto-Level v1.0 by SkyAxe - https://gamebanana.com/mods/727925)
 *
 * Spends ability unlocks and ability points automatically, in the order set by
 * the hero build you have selected.
 *
 * It does not read or replicate the build itself. Deadlock already marks the
 * next ability your build wants with the "build_suggestion" class (the small
 * "Recommended" badge you see while holding the scoreboard key). This script
 * waits until that step is affordable, then presses the same unlock / upgrade
 * button you would click yourself. With no build selected, or a build without
 * an ability order, it does nothing.
 *
 * Added in v0.1:
 *  - Manual override: refunding an upgrade, or upgrading a different ability by
 *    hand, pauses Auto-Level until you press Resume (or the hero/match changes),
 *    so a point you take back is not spent on the same ability again.
 *  - Settings panel on the HUD (top right, click the header to expand):
 *      On/Off, mode "all builds" or "only builds tagged [AL]", off for this hero,
 *      off for this build, delay before each purchase, Resume, Max now, Undo,
 *      and a Debug dump that writes what the script can see to the console.
 *  - "Only tagged builds" mode: put [AL] anywhere in a build's name to opt it in.
 *    This is also the way to limit the mod to your own builds.
 *
 * The script is included from two layouts (base_hud.xml and hud_data_feed.xml)
 * so another mod replacing one of them does not switch it off. A lock stored on
 * the Hud panel makes sure only one copy is active.
 *
 * Safety rules, because clicking a just-bought upgrade again sells it back:
 *  - never clicks an upgrade that is already owned or still refundable;
 *  - one action at a time, and it waits for the game to confirm the purchase
 *    before doing anything else;
 *  - after an unconfirmed click on an upgrade pip it waits out the refund window
 *    before that pip can be clicked again.
 */
(function () {
	'use strict';

	var VERSION = '0.1-dev';
	var TAG = '[BuildAutoLevel] ';
	var TICK_SECONDS = 0.25;          // how often the HUD is checked
	var CONFIRM_TIMEOUT_MS = 2000;    // how long to wait for the game to apply an action
	var PIP_RETRY_MS = 12000;         // longer than the 10s refund window
	var NEXT_METHOD_MS = 2000;        // pause before trying a different method
	var BACKOFF_MS = 30000;           // pause after every method failed
	var OWNER_STALE_MS = 3000;        // another copy takes over if the owner goes quiet
	var SLOT_COUNT = 4;               // signature abilities 1-3 + ultimate
	var DEBUG_STATUS = false;         // true: always-on diagnostic box (test builds)
	var TOAST_MS = 4000;              // how long the "upgraded ..." note stays on screen
	var NAMES_REFRESH_MS = 1500;      // how often hero and build names are re-read
	var BURST_MS = 30000;             // "Max now" gives up after this long
	var DELAY_CHOICES = [0, 1, 2, 3, 5];
	var BUILD_TAG_RE = /\[\s*(AL|AUTO)\s*\]/i;
	var BUILD_OFF_TAG_RE = /\[\s*no\s*-?\s*AL\s*\]/i;   // "[noAL]" in a build name switches it off for good

	function buildIsOff(name) {
		return !!name && (BUILD_OFF_TAG_RE.test(name) || !!settings.buildOff[name]);
	}

	var OWNER_ATTR = 'BuildAutoLevelOwner';
	var STATUS_ID = 'BuildAutoLevelStatus';
	var PANEL_ID = 'BuildAutoLevelPanel';
	var STORE_KEY = 'BuildAutoLevelSettings';

	// Ways of performing each action; the first one the game confirms is kept.
	// Confirmed in game (v0.3 test, Oct 2026): unlocks via the unlock event,
	// upgrades via the game's upgrade_ability command with 0-based slots.
	// The rest are fallbacks in case a game update changes this.
	var METHODS = {
		upgrade: ['cmd0', 'bitsPips', 'shownPip', 'eventPip', 'bitsPip', 'cmd1'],
		unlock: ['trainEvent', 'train', 'shownTrain', 'icon']
	};
	var METHOD_NAMES = {
		bitsPips: 'purchase event (tier bit)', bitsPip: 'purchase event on pip (tier bit)',
		eventPip: 'purchase event on pip', shownPip: 'pip click while shown',
		cmd0: 'upgrade_ability command (0-based)', cmd1: 'upgrade_ability command (1-based)',
		pip: 'upgrade pip', icon: 'ability icon', train: 'unlock button',
		trainEvent: 'unlock event', shownTrain: 'unlock button while shown'
	};
	// AbilityUpgradeBits_t from the game's schema: tier 1 = 2, tier 2 = 4, tier 3 = 8
	function tierBit(tier) {
		return 1 << tier;
	}

	var context = $.GetContextPanel();
	var instanceId = 'i' + Math.floor(Math.random() * 1e9) + '@' + (context && context.id ? context.id : '?');
	var hud = null;
	var slots = [];
	var pending = null;
	var backoffUntil = 0;
	var methodIndex = { upgrade: 0, unlock: 0 };
	var learned = { upgrade: -1, unlock: -1 };
	var failedRounds = { upgrade: 0, unlock: 0 };
	var actions = 0;
	var owner = false;
	var statusText = '';
	var lastStateLine = '';
	var lastDone = '';
	var problem = '';                 // shown until something works
	var toastUntil = 0;

	// v0.1 state
	var settings = defaultSettings();
	var storageKind = 'none';
	var settingsLoaded = false;
	var heroName = '';
	var buildName = '';
	var namesReadAt = 0;
	var manualPause = '';             // reason, empty when not paused
	var lastSeen = null;              // per-slot upgrade counts from the previous tick
	var lastSuggested = -1;           // slot index the build pointed at last tick
	var lastActed = -1;               // slot index of the last action this script made
	var plannedLabel = '';
	var plannedSince = 0;
	var burstUntil = 0;
	var burstIdle = 0;
	var undoRequested = false;
	var resumeAtTotal = -1;           // a refund pause ends when this many points are spent again
	var gateReason = '';

	function valid(panel) {
		return !!(panel && panel.IsValid && panel.IsValid());
	}

	function now() {
		return Date.now();
	}

	function log(message) {
		$.Msg(TAG + message);
	}

	function has(panel, cls) {
		return valid(panel) && panel.BHasClass(cls);
	}

	function hasInside(panel, cls) {
		if (!valid(panel)) {
			return false;
		}
		if (panel.BHasClass(cls)) {
			return true;
		}
		try {
			var found = panel.FindChildrenWithClassTraverse(cls);
			return !!(found && found.length);
		} catch (e) {
			return false;
		}
	}

	function directChild(panel, id) {
		if (!valid(panel)) {
			return null;
		}
		var kids = panel.Children() || [];
		for (var i = 0; i < kids.length; i++) {
			if (valid(kids[i]) && kids[i].id === id) {
				return kids[i];
			}
		}
		return null;
	}

	function windowRoot() {
		var panel = context;
		for (var i = 0; i < 80 && valid(panel); i++) {
			var parent = panel.GetParent();
			if (!valid(parent)) {
				return panel;
			}
			panel = parent;
		}
		return panel;
	}

	function findHud() {
		if (valid(hud)) {
			return hud;
		}
		hud = null;
		// base_hud.xml: the context is the window root, which owns Hud.
		var found = directChild(context, 'Hud');
		if (!found) {
			// hud_data_feed.xml: the context sits inside Hud.
			var panel = context;
			for (var i = 0; i < 60 && valid(panel); i++) {
				if (panel.id === 'Hud') {
					found = panel;
					break;
				}
				panel = panel.GetParent();
			}
		}
		hud = found || null;
		return hud;
	}

	// Only one copy may act. The owner refreshes a heartbeat on the Hud panel.
	function claimOwnership(root, t) {
		var raw = '';
		try {
			raw = root.GetAttributeString(OWNER_ATTR, '') || '';
		} catch (e) {
			raw = '';
		}
		var sep = raw.lastIndexOf('|');
		var who = sep > 0 ? raw.substring(0, sep) : '';
		var beat = sep > 0 ? Number(raw.substring(sep + 1)) : 0;
		if (who && who !== instanceId && t - beat < OWNER_STALE_MS && t >= beat) {
			if (owner) {
				owner = false;
			}
			return false;
		}
		try {
			root.SetAttributeString(OWNER_ATTR, instanceId + '|' + t);
		} catch (e2) {
			// no attribute support: every copy acts alone, which is still safe for a single hook
		}
		if (!owner) {
			owner = true;
			settingsLoaded = false;   // another copy may have changed them meanwhile
			log('v' + VERSION + ' active (' + instanceId + ')');
		}
		return true;
	}

	function slotsValid() {
		if (slots.length !== SLOT_COUNT) {
			return false;
		}
		for (var i = 0; i < slots.length; i++) {
			if (!valid(slots[i])) {
				return false;
			}
		}
		return true;
	}

	function findSlots(root) {
		if (slotsValid()) {
			return slots;
		}
		slots = [];
		var signature = null;
		var abilities = root.FindChildTraverse('AbilitiesContainer');
		if (valid(abilities)) {
			signature = abilities.FindChildTraverse('hud_signature');
		}
		if (!valid(signature)) {
			signature = root.FindChildTraverse('hud_signature');
		}
		if (!valid(signature)) {
			return slots;
		}
		var found = [];
		for (var i = 1; i <= SLOT_COUNT; i++) {
			var slot = signature.FindChildTraverse('slot_signature_' + i);
			if (!valid(slot)) {
				return slots;
			}
			found.push(slot);
		}
		slots = found;
		return slots;
	}

	// ---------------------------------------------------------------- settings

	function defaultSettings() {
		return {
			enabled: true,
			taggedOnly: false,        // true: only builds whose name contains [AL]
			delay: 0,                 // seconds to wait before each purchase
			heroOff: {},              // hero key -> true
			buildOff: {},             // build name -> true
			showBar: false,           // quick controls: HUD bar in matches (shop/scoreboard open), block in Sandbox tools
			barExpanded: false
		};
	}

	function applyLoaded(raw) {
		if (!raw) {
			return false;
		}
		try {
			var data = JSON.parse(raw);
			var base = defaultSettings();
			for (var k in base) {
				if (base.hasOwnProperty(k) && data.hasOwnProperty(k) && typeof data[k] === typeof base[k]) {
					base[k] = data[k];
				}
			}
			settings = base;
			return true;
		} catch (e) {
			log('could not read saved settings: ' + e);
			return false;
		}
	}

	// Saved settings survive a game restart only if the client offers persistent
	// storage; otherwise they live on the window root for this session.
	// Session copy first (instant), then the web store replaces it once it answers.
	function loadSettings() {
		settingsLoaded = true;
		storageKind = 'session';
		try {
			applyLoaded(windowRoot().GetAttributeString(STORE_KEY, ''));
		} catch (e) {
			// defaults it is
		}
		webStart();
	}

	// Copy on the window root: survives layout reloads within one map.
	function saveSession() {
		try {
			windowRoot().SetAttributeString(STORE_KEY, JSON.stringify(settings));
		} catch (e) {
			// nowhere to keep it
		}
	}

	function saveSettings() {
		saveSession();
		webSave();
	}

	// ---------------------------------------------------------------- web settings store
	//
	// Panorama gives scripts no file or storage access, but it can show web pages.
	// A tiny page on this project's GitHub Pages site keeps the settings in its
	// localStorage, which the game's embedded browser keeps between sessions
	// (the same approach as the HP COLORS mod). The page is loaded in a hidden
	// HTML panel; requests go in the URL fragment, replies come back in the
	// page title. The fragment is never sent over the network.

	var WEB_STORE_URL = 'https://riveany.github.io/AutoUpgradeSkill-DeadLock/store/';
	var WEB_STORE_KEY = 'bal.settings';
	var WEB_REPLY_PREFIX = 'BALS1:';
	var web = {
		panel: null, ready: false, failed: false, seq: 0, queue: [], waiting: null,
		startedAt: 0, lastHello: 0, dirty: false, saveScheduled: false
	};

	function webSend(msg) {
		msg.i = instanceId + ':' + (++web.seq);
		web.panel.SetURL(WEB_STORE_URL + '#' + encodeURIComponent(JSON.stringify(msg)));
		return msg.i;
	}

	function webPump() {
		if (!web.ready || web.waiting || !web.queue.length || !valid(web.panel)) {
			return;
		}
		var request = web.queue.shift();
		request.id = webSend(request.msg);
		request.deadline = now() + 5000;
		web.waiting = request;
	}

	function webQueue(msg, callback) {
		web.queue.push({ msg: msg, cb: callback });
		webPump();
	}

	function webHello() {
		web.lastHello = now();
		webSend({ o: 'hello' });
	}

	function webOnTitle(a, b) {
		var title = String((arguments.length > 1 ? b : a) || '');
		if (title.indexOf(WEB_REPLY_PREFIX) !== 0) {
			return;
		}
		var reply = null;
		try {
			reply = JSON.parse(title.slice(WEB_REPLY_PREFIX.length));
		} catch (e) {
			return;
		}
		if (!reply || typeof reply.i !== 'string' || reply.i.indexOf(instanceId + ':') !== 0) {
			return; // another copy's request, or the page's loading title
		}
		if (reply.o === 'ready') {
			if (!web.ready && reply.ok) {
				web.ready = true;
				web.failed = false;
				storageKind = 'web';
				log('web settings store ready');
				webQueue({ o: 'get', k: WEB_STORE_KEY }, function (r) {
					if (web.dirty) {
						webSave(); // changed before the store answered: keep the local choice
					} else if (r.ok && r.v && applyLoaded(r.v)) {
						log('settings loaded from the web store');
						saveSession();
					}
					renderUi();
				});
			}
			return;
		}
		if (web.waiting && reply.i === web.waiting.id) {
			var done = web.waiting;
			web.waiting = null;
			if (!reply.ok) {
				log('web store ' + done.msg.o + ' failed: ' + reply.e);
			}
			if (done.cb) {
				done.cb(reply);
			}
			webPump();
		}
	}

	function webStart() {
		if (valid(web.panel)) {
			return;
		}
		try {
			var host = windowRoot();
			var panel = host.FindChildTraverse('BALWebStore');
			if (!valid(panel)) {
				panel = $.CreatePanel('HTML', host, 'BALWebStore');
				panel.style.width = '4px';
				panel.style.height = '4px';
				panel.style.opacity = '0';
				panel.hittest = false;
			}
			web.panel = panel;
			web.ready = false;
			$.RegisterEventHandler('HTMLTitle', panel, webOnTitle);
			web.startedAt = now();
			webHello();
		} catch (e) {
			web.failed = true;
			log('web settings store unavailable: ' + e);
		}
	}

	function webTick(t) {
		if (!valid(web.panel) || web.failed) {
			return;
		}
		if (!web.ready) {
			if (t - web.startedAt > 30000) {
				web.failed = true;
				log('web settings store did not answer (offline, or GitHub Pages not enabled); settings last for this map only');
				renderUi();
			} else if (t - web.lastHello > 4000) {
				webHello(); // the page may have finished loading after the first request
			}
			return;
		}
		if (web.waiting && t > web.waiting.deadline) {
			log('web store ' + web.waiting.msg.o + ' timed out');
			web.waiting = null;
			webPump();
		}
	}

	function webSave() {
		if (!web.ready) {
			web.dirty = true;
			return;
		}
		web.dirty = false;
		if (web.saveScheduled) {
			return;
		}
		web.saveScheduled = true;
		$.Schedule(0.5, function () {
			web.saveScheduled = false;
			webQueue({ o: 'set', k: WEB_STORE_KEY, v: JSON.stringify(settings) });
		});
	}

	function storageText() {
		if (web.ready) {
			return 'saved (web store)';
		}
		if (web.failed) {
			return 'this map only (web store unreachable)';
		}
		return valid(web.panel) ? 'connecting to the web store...' : 'this map only';
	}


	// ---------------------------------------------------------------- hero and build names

	function labelText(panel) {
		if (!valid(panel)) {
			return '';
		}
		try {
			return String(panel.text || '').replace(/<[^>]*>/g, '').replace(/^\s+|\s+$/g, '');
		} catch (e) {
			return '';
		}
	}

	// The shop header reads "<hero>'s Recommended Mods" (localised); the whole
	// text is used as the hero key, since only its stability matters.
	function readHeroName(top) {
		var label = top.FindChildTraverse('HeroFavoritesHeaderLabel');
		var text = labelText(label);
		if (text.charAt(0) === '#' || text.indexOf('{') >= 0) {
			return '';
		}
		return text;
	}

	function readBuildName(top) {
		var outer = top.FindChildTraverse('SelectedBuildOuter');
		var scopes = valid(outer) ? [outer, top] : [top];
		for (var s = 0; s < scopes.length; s++) {
			var found = [];
			try {
				found = scopes[s].FindChildrenWithClassTraverse('SelectedBuildName') || [];
			} catch (e) {
				found = [];
			}
			for (var i = 0; i < found.length; i++) {
				var text = labelText(found[i]);
				if (text && text.charAt(0) !== '#') {
					return text;
				}
			}
		}
		return '';
	}

	function refreshNames(t) {
		if (t - namesReadAt < NAMES_REFRESH_MS) {
			return;
		}
		namesReadAt = t;
		var top = windowRoot();
		var hero = readHeroName(top);
		var build = readBuildName(top);
		if (hero && hero !== heroName) {
			if (heroName) {
				log('hero changed: ' + hero);
				resumeAuto('hero changed');
			}
			heroName = hero;
		}
		if (build !== buildName) {
			log('build: ' + (build || '(none read)'));
			buildName = build;
		}
	}

	// Why Auto-Level should not spend points right now; empty when it may.
	function gate() {
		if (!settings.enabled) {
			return 'off';
		}
		if (manualPause) {
			return 'paused: ' + manualPause;
		}
		if (heroName && settings.heroOff[heroName]) {
			return 'off for this hero';
		}
		if (buildName && BUILD_OFF_TAG_RE.test(buildName)) {
			return 'off for this build ([noAL] in its name)';
		}
		if (buildName && settings.buildOff[buildName]) {
			return 'off for this build';
		}
		if (settings.taggedOnly) {
			if (!buildName) {
				return 'tagged-only: build name not visible yet (open the shop once)';
			}
			if (!BUILD_TAG_RE.test(buildName)) {
				return 'tagged-only: build has no [AL] tag';
			}
		}
		return '';
	}

	function pauseAuto(reason) {
		if (manualPause) {
			return;
		}
		manualPause = reason;
		pending = null;
		burstUntil = 0;
		log('paused: ' + reason);
	}

	function resumeAuto(why) {
		if (manualPause) {
			log('resumed (' + why + ')');
		}
		manualPause = '';
		resumeAtTotal = -1;
		lastSeen = null;
	}

	// ---------------------------------------------------------------- status line

	function statusPanel(root) {
		var label = directChild(root, STATUS_ID);
		if (valid(label)) {
			return label;
		}
		try {
			label = $.CreatePanel('Label', root, STATUS_ID);
			label.hittest = false;
			label.style.horizontalAlign = 'right';
			label.style.verticalAlign = 'top';
			label.style.marginRight = '24px';
			label.style.marginTop = '320px';
			label.style.maxWidth = '420px';
			label.style.padding = '6px 10px';
			label.style.borderRadius = '6px';
			label.style.backgroundColor = '#000000b0';
			label.style.color = '#f0e6d2';
			label.style.fontSize = '15px';
			label.style.zIndex = '1000';
			return label;
		} catch (e) {
			return null;
		}
	}

	function showText(root, full) {
		var label = statusPanel(root);
		if (!label) {
			return;
		}
		if (label.text !== full) {
			label.text = full;
		}
		label.style.visibility = 'visible';
	}

	// Short on-screen note; persistent notes stay until something works again.
	function toast(root, text, persistent) {
		if (DEBUG_STATUS || !valid(root)) {
			return;
		}
		showText(root, 'Auto-Level: ' + text);
		toastUntil = persistent ? -1 : now() + TOAST_MS;
	}

	// Detailed diagnostic box, only in test builds.
	function setStatus(root, text) {
		statusText = text;
		if (!DEBUG_STATUS || !valid(root)) {
			return;
		}
		var label = statusPanel(root);
		if (!label) {
			return;
		}
		var known = [];
		if (learned.unlock >= 0) {
			known.push('unlock: ' + METHOD_NAMES[METHODS.unlock[learned.unlock]]);
		}
		if (learned.upgrade >= 0) {
			known.push('upgrade: ' + METHOD_NAMES[METHODS.upgrade[learned.upgrade]]);
		}
		var full = 'Auto-Level v' + VERSION + ': ' + text + (problem ? '\n' + problem : '') +
			(known.length ? '\nworks -> ' + known.join(', ') : '') +
			(lastStateLine ? '\n' + lastStateLine : '');
		showText(root, full);
	}

	function hideStatus(root) {
		var label = directChild(root, STATUS_ID);
		if (valid(label)) {
			label.style.visibility = 'collapse';
		}
	}

	// ---------------------------------------------------------------- user interface
	//
	// Three places, all built from script because layouts cannot be recompiled here:
	//  - game Settings popup: the full settings block (injected while it is open);
	//  - build browser: an Auto-Level on/off button beside "Build Options";
	//  - HUD: a small bar (status + Max now / Undo / Resume), shown only while the
	//    mouse cursor is free. Its [...] button opens the full block as a fallback
	//    in case the Settings popup cannot be found.

	var COLOR_TEXT = '#f0e6d2';
	var COLOR_DIM = '#c8bfae';
	var COLOR_BUTTON = '#3a3328e0';
	var COLOR_OFF = '#5a2a22e0';
	var ATTACH_EVERY_MS = 1000;

	var blocks = [];                  // full settings blocks: { root, info, labels }
	var bar = null;                   // HUD bar: { root, status, resume, more, block }
	var settingsUi = null;            // block inside the Settings popup
	var attachedAt = 0;

	function setShown(panel, shown) {
		if (!valid(panel)) {
			return;
		}
		panel.style.visibility = shown ? 'visible' : 'collapse';
		try {
			panel.visible = shown;
		} catch (e) {
			// style alone is enough
		}
	}

	function setLabel(label, text) {
		if (valid(label) && label.text !== text) {
			label.text = text;
		}
	}

	function shortName(text) {
		return text.length > 28 ? text.substring(0, 26) + '..' : text;
	}

	function makeLabel(parent, id, size, color) {
		var label = $.CreatePanel('Label', parent, id);
		label.style.color = color;
		label.style.fontSize = size;
		label.hittest = false;
		return label;
	}

	function makeButton(parent, id, width, onClick) {
		var button = $.CreatePanel('Panel', parent, id);
		button.style.width = width;
		button.style.height = '24px';
		button.style.margin = '2px';
		button.style.borderRadius = '4px';
		button.style.backgroundColor = COLOR_BUTTON;
		var label = makeLabel(button, id + 'Label', '13px', COLOR_TEXT);
		label.style.horizontalAlign = 'center';
		label.style.verticalAlign = 'center';
		button.SetPanelEvent('onactivate', function () {
			try {
				onClick();
			} catch (err) {
				log('button ' + id + ' threw: ' + err);
			}
			renderUi();
		});
		label.button = button;
		return label;
	}

	function makeRow(parent) {
		var row = $.CreatePanel('Panel', parent, '');
		row.style.flowChildren = 'right';
		return row;
	}

	function toggleBuild(name) {
		if (!name) {
			return;
		}
		if (settings.buildOff[name]) {
			delete settings.buildOff[name];
		} else {
			settings.buildOff[name] = true;
		}
		saveSettings();
	}

	function startMaxNow() {
		burstUntil = now() + BURST_MS;
		burstIdle = 0;
		manualPause = '';
		lastSeen = null;
		log('Max now pressed');
	}

	// The full settings block, used in the Settings popup and behind the HUD bar's [...].
	function buildBlock(parent, prefix, withTitle) {
		var root = $.CreatePanel('Panel', parent, prefix + 'Block');
		root.style.flowChildren = 'down';
		if (withTitle) {
			makeLabel(root, '', '18px', COLOR_TEXT).text = 'Build Auto-Level v' + VERSION;
		}
		var info = makeLabel(root, '', '12px', COLOR_DIM);
		info.style.marginBottom = '4px';
		var row = makeRow(root);
		var labels = {
			enabled: makeButton(row, prefix + 'Enabled', '70px', function () {
				settings.enabled = !settings.enabled;
				saveSettings();
			}),
			bar: makeButton(row, prefix + 'Bar', '110px', function () {
				settings.showBar = !settings.showBar;
				saveSettings();
			}),
			dump: makeButton(row, prefix + 'Dump', '60px', function () {
				debugDump();
			})
		};
		var block = { root: root, info: info, labels: labels };
		blocks.push(block);
		return block;
	}

	function renderBlock(block) {
		if (!valid(block.root)) {
			return;
		}
		var offBuilds = 0;
		for (var k in settings.buildOff) {
			if (settings.buildOff.hasOwnProperty(k)) {
				offBuilds++;
			}
		}
		setLabel(block.info, 'Status: ' + (gateReason || 'ON') +
			'\nBuild in use: ' + (buildName ? shortName(buildName) : '?') +
			'\nBuilds switched off: ' + offBuilds + ' (AL button after each name in the build browser)');
		var b = block.labels;
		setLabel(b.enabled, settings.enabled ? 'On' : 'Off');
		setLabel(b.bar, settings.showBar ? 'HUD bar: on' : 'HUD bar: off');
		setLabel(b.dump, 'Debug');
	}

	function togglePause() {
		if (manualPause) {
			resumeAuto('Resume pressed');
		} else {
			pauseAuto('paused by you');
		}
	}

	function renderUi() {
		renderHub();
		var alive = [];
		for (var i = 0; i < blocks.length; i++) {
			if (valid(blocks[i].root)) {
				renderBlock(blocks[i]);
				if (blocks[i].pause) {
					setLabel(blocks[i].pause, manualPause ? 'Resume' : 'Pause');
				}
				alive.push(blocks[i]);
			}
		}
		blocks = alive;
		if (bar && valid(bar.root)) {
			var state = gateReason ? gateReason : (burstUntil ? 'Max now...' : 'ON');
			setLabel(bar.status, 'Auto-Level: ' + state);
			setLabel(bar.resume, manualPause ? 'Resume' : 'Pause');
			setLabel(bar.max, 'Max now');
			setLabel(bar.undo, 'Undo');
			setLabel(bar.more, settings.barExpanded ? '[-]' : '[...]');
			setShown(bar.block.root, settings.barExpanded);
		}
		for (var n = 0; n < buildButtons.length; n++) {
			var entry = buildButtons[n];
			if (!valid(entry.label)) {
				continue;
			}
			var tagged = !!entry.name && BUILD_OFF_TAG_RE.test(entry.name);
			var off = buildIsOff(entry.name);
			setLabel(entry.label, 'AL: ' + (!entry.name ? '?' : tagged ? 'OFF (tag)' : off ? 'OFF' : 'ON'));
			entry.button.style.backgroundColor = off ? COLOR_OFF : COLOR_BUTTON;
		}
	}

	// ---------------------------------------------------------------- HUD bar

	function buildBar(root) {
		if (bar && valid(bar.root)) {
			return bar;
		}
		var existing = directChild(root, PANEL_ID);
		if (valid(existing)) {
			// left behind by a copy that lost ownership
			existing.DeleteAsync(0);
		}
		try {
			var box = $.CreatePanel('Panel', root, PANEL_ID);
			box.style.horizontalAlign = 'right';
			box.style.verticalAlign = 'bottom';
			box.style.marginRight = '20px';
			box.style.marginBottom = '150px';
			box.style.flowChildren = 'down';
			box.style.padding = '3px 6px';
			box.style.borderRadius = '6px';
			box.style.backgroundColor = '#000000c0';
			box.style.zIndex = '1001';
			var line = makeRow(box);
			var status = makeLabel(line, '', '13px', COLOR_TEXT);
			status.style.verticalAlign = 'center';
			status.style.marginRight = '6px';
			bar = {
				root: box,
				status: status,
				max: makeButton(line, 'BALBarMax', '70px', startMaxNow),
				undo: makeButton(line, 'BALBarUndo', '52px', function () {
					undoRequested = true;
				}),
				resume: makeButton(line, 'BALBarResume', '64px', togglePause),
				more: makeButton(line, 'BALBarMore', '40px', function () {
					settings.barExpanded = !settings.barExpanded;
					saveSettings();
				})
			};
			bar.block = buildBlock(box, 'BALBar', false);
			renderUi();
			return bar;
		} catch (e) {
			log('HUD bar failed: ' + e);
			bar = null;
			return null;
		}
	}

	// Compiled layouts store ids and classes in one string table, so whether a
	// name is an id or a class cannot be told from the files: try both.
	function findAll(top, key) {
		var out = [];
		if (!valid(top)) {
			return out;
		}
		var byId = top.FindChildTraverse(key);
		if (valid(byId)) {
			out.push(byId);
		}
		try {
			var byClass = top.FindChildrenWithClassTraverse(key) || [];
			for (var i = 0; i < byClass.length && out.length < 8; i++) {
				if (valid(byClass[i])) {
					out.push(byClass[i]); // may repeat the id match; callers tolerate that
				}
			}
		} catch (e) {
			// class search not available
		}
		return out;
	}

	function findOne(top, keys) {
		for (var i = 0; i < keys.length; i++) {
			var found = findAll(top, keys[i]);
			if (found.length) {
				return found[0];
			}
		}
		return null;
	}

	// Shop, scoreboard and the Sandbox test tools are GlobalClassListener panels:
	// while one of them is open, the listening panels carry gShopOpen /
	// gScoreboardOpen. Until such a class has been seen once, the bar stays
	// visible so it can never become unreachable.
	var CURSOR_CLASSES = ['gShopOpen', 'gScoreboardOpen', 'gEditingBuilds'];
	var cursorClassSeen = false;
	var cursorOpen = false;
	var cursorCheckedAt = 0;

	function cursorScreenOpen(root) {
		var t = now();
		if (t - cursorCheckedAt < 500) {
			return cursorOpen || !cursorClassSeen;
		}
		cursorCheckedAt = t;
		cursorOpen = false;
		var scopes = [root, windowRoot()];
		for (var s = 0; s < scopes.length && !cursorOpen; s++) {
			for (var c = 0; c < CURSOR_CLASSES.length && !cursorOpen; c++) {
				if (has(scopes[s], CURSOR_CLASSES[c])) {
					cursorOpen = true;
				} else {
					try {
						var found = scopes[s].FindChildrenWithClassTraverse(CURSOR_CLASSES[c]) || [];
						cursorOpen = found.length > 0;
					} catch (e) {
						// keep looking
					}
				}
			}
		}
		if (cursorOpen) {
			cursorClassSeen = true;
		}
		return cursorOpen || !cursorClassSeen;
	}

	function hidePanel(root) {
		if (bar && valid(bar.root)) {
			setShown(bar.root, false);
		}
	}

	function showPanel(root) {
		// In the Sandbox the controls live inside the test tools menu instead.
		if (!settings.showBar || sandbox) {
			hidePanel(root);
			return;
		}
		var built = buildBar(root);
		if (built && valid(built.root)) {
			setShown(built.root, true);
		}
	}

	// ---------------------------------------------------------------- Settings popup, test tools, build browser

	var toolsUi = null;               // block inside the Sandbox test tools menu
	var sandbox = false;              // the test tools menu exists: Sandbox / hero testing
	var buildButtons = [];            // [{ button, label, name, controls }]

	function injectBlock(host, hostId, prefix, title) {
		var stale = host.FindChildTraverse(hostId);
		if (valid(stale)) {
			stale.DeleteAsync(0);
		}
		var frame = $.CreatePanel('Panel', host, hostId);
		frame.style.flowChildren = 'down';
		frame.style.margin = '12px 8px';
		frame.style.padding = '8px 10px';
		frame.style.borderRadius = '6px';
		frame.style.backgroundColor = '#000000a0';
		makeLabel(frame, '', '18px', COLOR_TEXT).text = 'Build Auto-Level v' + VERSION;
		// actions first: hosts may clip the bottom of the block
		var row = makeRow(frame);
		makeButton(row, prefix + 'Max', '76px', startMaxNow).text = 'Max now';
		makeButton(row, prefix + 'Undo', '60px', function () {
			undoRequested = true;
		}).text = 'Undo';
		var pause = makeButton(row, prefix + 'Pause', '70px', togglePause);
		var block = buildBlock(frame, prefix, false);
		block.pause = pause;
		block.root = frame;
		log(title + ' (' + (host.id || 'no id') + ')');
		renderUi();
		return block;
	}

	// Left column of the game's Settings popup: appended to the list of section
	// buttons (the column itself clips anything placed below that list).
	function attachSettings(top) {
		if (settingsUi && valid(settingsUi.root)) {
			return;
		}
		var host = findOne(top, ['SettingsNavigationButtonsContainer', 'PopupSettingsNavigationContainer', 'SettingsNavigationContainer']);
		if (!host) {
			return;
		}
		try {
			settingsUi = injectBlock(host, 'BALSettingsHost', 'BALSettings', 'settings added to the Settings popup');
		} catch (e) {
			log('settings popup injection failed: ' + e);
			settingsUi = null;
		}
	}

	// Sandbox: the "hero tools" tab of the test tools menu (hold Tab).
	function attachTestTools(top) {
		if (toolsUi && valid(toolsUi.root)) {
			setShown(toolsUi.root, settings.showBar);
			return;
		}
		var host = findOne(top, ['hero_tools']);
		if (!host) {
			return;
		}
		try {
			toolsUi = injectBlock(host, 'BALToolsHost', 'BALTools', 'settings added to the test tools menu');
		} catch (e) {
			log('test tools injection failed: ' + e);
			toolsUi = null;
		}
	}

	// FindChildTraverse only returns the first match; rows repeat the same ids.
	function descendantsWithId(panel, id, limit) {
		var out = [];
		var visit = function (node, depth) {
			if (!valid(node) || depth > 40 || out.length >= limit) {
				return;
			}
			var kids = node.Children() || [];
			for (var i = 0; i < kids.length && out.length < limit; i++) {
				if (kids[i].id === id || kids[i].BHasClass(id)) {
					out.push(kids[i]);
				} else {
					visit(kids[i], depth + 1);
				}
			}
		};
		visit(panel, 0);
		return out;
	}

	// The build browser lists builds as rows, each with a BuildName label. Every
	// row gets a small Auto-Level toggle right after its name.
	var lastRowCount = -1;

	function attachBuildButtons(top) {
		var alive = [];
		for (var i = 0; i < buildButtons.length; i++) {
			if (valid(buildButtons[i].button) && valid(buildButtons[i].nameLabel)) {
				alive.push(buildButtons[i]);
			}
		}
		buildButtons = alive;
		var selectors = [];
		var popups = findAll(top, 'PopupPanel');
		for (var pp = 0; pp < popups.length; pp++) {
			var inPopup = popups[pp].FindChildTraverse('HeroBuildSelector');
			if (valid(inPopup)) {
				selectors.push(inPopup);
			}
		}
		if (!selectors.length) {
			var anySelector = findOne(top, ['HeroBuildSelector']);
			if (!anySelector) {
				return;
			}
			selectors.push(anySelector);
		}
		var labels = [];
		for (var sx = 0; sx < selectors.length; sx++) {
			labels = labels.concat(descendantsWithId(selectors[sx], 'BuildName', 40));
		}
		if (labels.length !== lastRowCount) {
			lastRowCount = labels.length;
			log('build browser: ' + labels.length + ' build rows in ' + selectors.length + ' list(s)');
		}
		for (var f = 0; f < labels.length && f < 40; f++) {
			var nameLabel = labels[f];
			var row = nameLabel.GetParent();
			if (!valid(row) || valid(row.FindChildTraverse('BALRowToggle'))) {
				continue;
			}
			try {
				var entry = { name: '', nameLabel: nameLabel };
				var label = makeButton(row, 'BALRowToggle', '74px', (function (e) {
					return function () {
						toggleBuild(e.name);
					};
				})(entry));
				label.button.style.height = '22px';
				label.button.style.marginLeft = '10px';
				label.button.style.verticalAlign = 'center';
				label.style.fontSize = '12px';
				try {
					row.MoveChildAfter(label.button, nameLabel);
				} catch (e2) {
					// stays at the end of the row
				}
				entry.button = label.button;
				entry.label = label;
				buildButtons.push(entry);
			} catch (e) {
				log('build row toggle failed: ' + e);
				break;
			}
		}
		for (var n = 0; n < buildButtons.length; n++) {
			buildButtons[n].name = labelText(buildButtons[n].nameLabel);
		}
	}

	function attachAll(t) {
		if (t - attachedAt < ATTACH_EVERY_MS) {
			return;
		}
		attachedAt = t;
		var top = windowRoot();
		sandbox = !!findOne(top, ['hud_hero_testing_root', 'hero_tools']);
		attachEscapeMenu(top);
		attachTestTools(top);
		attachBuildButtons(top);
		renderUi();
	}

	// ---------------------------------------------------------------- Esc menu "MOD" hub
	//
	// A "MOD" entry in the Esc menu opens a full page: list of mods on the left,
	// the selected mod's settings on the right. Convention, so future mods can
	// join without knowing this one:
	//   menu entry  #ModHubMenuEntry   inserted before the Esc menu's Settings row
	//   hub page    #ModHubPanel       child of the Esc menu root, class ModHubOpen while shown
	//   sections    #ModHubSections    each mod appends a panel #ModHubSection_<Name>
	//                                  with attribute ModHubTitle = name shown in the list
	// Mods that ship their own Esc entry (HP COLORS) are listed too: picking them
	// opens their own page, and their separate Esc entry is hidden.

	var HUB_SECTION_ID = 'ModHubSection_BuildAutoLevel';
	var EXTERNAL_MODS = ['HP COLORS'];
	var hubUi = null;                 // our section: { root, status, labels }
	var hubPanel = null;
	var hubListSig = '';
	var externalEntries = {};         // name -> Esc menu entry of that mod

	function escapeMenuRoot(row) {
		var panel = row;
		for (var i = 0; i < 15 && valid(panel); i++) {
			if (valid(panel.FindChildTraverse('RightSide')) || valid(panel.FindChildTraverse('EscapeBackground'))) {
				return panel;
			}
			panel = panel.GetParent();
		}
		return null;
	}

	// The Esc menu keeps its panels when it closes, so the page would come back
	// open next time. Its root changes (class, visibility or size) when it
	// closes; any change seen while the page is open closes the page.
	var MENU_STATE_CLASSES = ['Hidden', 'hidden', 'Visible', 'visible', 'Active', 'active', 'Open', 'open',
		'Show', 'show', 'Shown', 'Closed', 'closed', 'Minimized', 'EscapeMenuOpen', 'EscapeMenuVisible',
		'MenuOpen', 'MenuVisible', 'ShowMenu', 'InMenu', 'Paused', 'gEscapeMenuOpen', 'gMenuOpen'];
	var hubMenuRoot = null;
	var hubOpenedAt = 0;
	var hubOpenSig = '';
	var menuSigLogs = 0;

	function panelState(panel) {
		var vis = '?';
		try {
			vis = panel.visible ? 'v' : 'h';
		} catch (e) {
			vis = '?';
		}
		return (panel.id || panel.paneltype || '?') + ':' + vis + ':' + classList(panel, MENU_STATE_CLASSES) +
			':' + panel.actuallayoutwidth;
	}

	// State of the Esc menu root and all its ancestors; any of them may be the
	// one the game hides when the menu closes.
	function menuSignature(root) {
		if (!valid(root)) {
			return 'gone';
		}
		var parts = [];
		for (var panel = root, d = 0; valid(panel) && d < 12; panel = panel.GetParent(), d++) {
			parts.push(panelState(panel));
		}
		var right = root.FindChildTraverse('RightSide');
		parts.push('right:' + (valid(right) ? right.actuallayoutwidth : '-'));
		return parts.join(' < ');
	}

	function watchHub(t) {
		if (!valid(hubPanel) || !hubPanel.BHasClass('ModHubOpen')) {
			return;
		}
		var sig = menuSignature(hubMenuRoot);
		if (!hubOpenSig) {
			if (t - hubOpenedAt > 300) {
				hubOpenSig = sig;
			}
			return;
		}
		if (sig !== hubOpenSig) {
			if (menuSigLogs++ < 20) {
				log('Esc menu changed (' + hubOpenSig + ' -> ' + sig + '); closing the MOD page');
			}
			hubSetOpen(hubPanel, false);
		}
	}

	function hubSetOpen(hub, open) {
		hub.SetHasClass('ModHubOpen', open);
		setShown(hub, open);
		hubOpenedAt = now();
		hubOpenSig = '';
		if (open) {
			hubListSig = '';
			renderHub();
			// with focus on the page, Esc reaches its oncancel before the menu's
			try {
				hub.SetAcceptsFocus(true);
			} catch (e) {
				// no focus support: the close detection below still applies
			}
			try {
				hub.SetFocus();
			} catch (e2) {
				// same
			}
		}
	}

	function ensureHub(menuRoot) {
		var hub = menuRoot.FindChildTraverse('ModHubPanel');
		if (valid(hub)) {
			return hub;
		}
		hub = $.CreatePanel('Panel', menuRoot, 'ModHubPanel');
		hub.style.width = '100%';
		hub.style.height = '100%';
		hub.style.backgroundColor = '#0b0d0cf7';
		hub.style.flowChildren = 'right';
		hub.style.zIndex = '1002';
		hub.SetPanelEvent('oncancel', function () {
			log('Esc on the MOD page: back to the Esc menu');
			hubSetOpen(hub, false);
		});

		var left = $.CreatePanel('Panel', hub, 'ModHubNav');
		left.style.width = '360px';
		left.style.height = '100%';
		left.style.padding = '110px 20px 30px 30px';
		left.style.flowChildren = 'down';
		var title = makeLabel(left, '', '44px', '#7fe0a0');
		title.text = 'MODS';
		title.style.fontWeight = 'bold';
		title.style.marginBottom = '18px';
		var list = $.CreatePanel('Panel', left, 'ModHubList');
		list.style.flowChildren = 'down';
		list.style.width = '100%';
		var note = makeLabel(left, 'ModHubExternalNote', '13px', COLOR_DIM);
		note.text = 'Items with > open that mod\'s own page.\nIts back button returns to the Esc menu;\npress MOD to come back here.';
		note.style.marginTop = '12px';
		var back = makeButton(left, 'ModHubClose', '120px', function () {
			hubSetOpen(hub, false);
		});
		back.text = 'BACK';
		back.button.style.marginTop = '30px';
		back.button.style.height = '34px';

		var right = $.CreatePanel('Panel', hub, 'ModHubSections');
		right.style.width = 'fill-parent-flow(1)';
		right.style.height = '100%';
		right.style.padding = '110px 60px 30px 30px';
		right.style.flowChildren = 'down';
		right.style.overflow = 'squish scroll';

		hubSetOpen(hub, false);
		return hub;
	}

	// One setting row: name on the left, ON/OFF button on the right.
	function hubToggleRow(parent, id, name, onClick) {
		var row = makeRow(parent);
		row.style.width = '100%';
		row.style.padding = '10px 0px';
		row.style.borderBottom = '1px solid #ffffff14';
		var label = makeLabel(row, '', '20px', COLOR_TEXT);
		label.text = name;
		label.style.verticalAlign = 'center';
		var value = makeButton(row, id, '100px', onClick);
		value.button.style.horizontalAlign = 'right';
		value.button.style.height = '34px';
		value.style.fontSize = '17px';
		return value;
	}

	function buildHubSection(hub) {
		var sections = hub.FindChildTraverse('ModHubSections');
		var stale = sections.FindChildTraverse(HUB_SECTION_ID);
		if (valid(stale)) {
			stale.DeleteAsync(0);
		}
		var root = $.CreatePanel('Panel', sections, HUB_SECTION_ID);
		root.SetAttributeString('ModHubTitle', 'Build Auto-Level');
		root.style.flowChildren = 'down';
		root.style.width = '100%';
		var name = makeLabel(root, '', '40px', '#7fe0a0');
		name.text = 'BUILD AUTO-LEVEL';
		name.style.fontWeight = 'bold';
		var sub = makeLabel(root, '', '16px', COLOR_DIM);
		sub.text = 'v' + VERSION + ' - spends ability points in the order of the selected build.';
		sub.style.marginBottom = '18px';
		var status = makeLabel(root, '', '16px', COLOR_TEXT);
		status.style.marginBottom = '12px';
		var labels = {
			enabled: hubToggleRow(root, 'BALHubEnabled', 'Auto-level abilities', function () {
				settings.enabled = !settings.enabled;
				saveSettings();
			}),
			bar: hubToggleRow(root, 'BALHubBar', 'Quick controls: Max now / Undo / Pause (HUD bar, Sandbox tools)', function () {
				settings.showBar = !settings.showBar;
				saveSettings();
			}),
			pause: hubToggleRow(root, 'BALHubPause', 'Running now (pause until you resume)', togglePause)
		};
		var hint = makeLabel(root, '', '15px', COLOR_DIM);
		hint.style.marginTop = '14px';
		hint.text = 'Per build: AL button after each build name in the build browser (B > Browse builds).\n' +
			'To switch a build off permanently, put [noAL] in its name - the game saves that with the build.\n' +
			'Refunding an upgrade pauses auto-level until you spend that point again.\n' +
			'Settings are saved through a small page on the project\'s GitHub Pages site (needs internet);\n' +
			'without it they last for the current map only.';
		var tools = makeRow(root);
		tools.style.marginTop = '14px';
		makeButton(tools, 'BALHubDump', '80px', function () {
			debugDump();
		}).text = 'Debug';
		return { root: root, status: status, labels: labels };
	}

	// Mods that put their own entry in the Esc menu, found by the entry's text.
	function findExternalEntries(menuParent) {
		var kids = menuParent.Children() || [];
		for (var i = 0; i < kids.length; i++) {
			var kid = kids[i];
			if (!valid(kid) || kid.id === 'ModHubMenuEntry') {
				continue;
			}
			var text = labelText(kid);
			if (!text) {
				var inner = kid.Children() || [];
				for (var j = 0; j < inner.length && !text; j++) {
					text = labelText(inner[j]);
				}
			}
			text = String(text || '').toUpperCase();
			for (var e = 0; e < EXTERNAL_MODS.length; e++) {
				if (text === EXTERNAL_MODS[e]) {
					if (!externalEntries[text]) {
						log('found ' + text + ' entry in the Esc menu; listing it under MOD');
					}
					externalEntries[text] = kid;
					setShown(kid, false);
				}
			}
		}
	}

	function selectHubItem(hub, key) {
		hub.SetAttributeString('ModHubSelected', key);
		hubListSig = '';
		renderHub();
	}

	function hubListButton(list, key, title, onClick) {
		var label = makeButton(list, '', '300px', onClick);
		label.text = title;
		label.style.fontSize = '22px';
		label.style.horizontalAlign = 'left';
		label.style.marginLeft = '14px';
		label.button.style.height = '44px';
		label.button.style.marginBottom = '6px';
		label.button.style.backgroundColor = '#00000000';
		return label;
	}

	// Rebuilds the left list when the set of sections changes and shows only the
	// selected section.
	function renderHubList(hub) {
		var sections = hub.FindChildTraverse('ModHubSections');
		var list = hub.FindChildTraverse('ModHubList');
		if (!valid(sections) || !valid(list)) {
			return;
		}
		var items = [];
		var kids = sections.Children() || [];
		for (var i = 0; i < kids.length; i++) {
			if (valid(kids[i])) {
				items.push({ key: kids[i].id, title: kids[i].GetAttributeString('ModHubTitle', kids[i].id), panel: kids[i] });
			}
		}
		for (var name in externalEntries) {
			if (externalEntries.hasOwnProperty(name) && valid(externalEntries[name])) {
				items.push({ key: 'external:' + name, title: name, entry: externalEntries[name] });
			}
		}
		var selected = hub.GetAttributeString('ModHubSelected', '');
		var found = false;
		for (var s = 0; s < items.length; s++) {
			if (items[s].key === selected && !items[s].entry) {
				found = true;
			}
		}
		if (!found && items.length && !items[0].entry) {
			selected = items[0].key;
			hub.SetAttributeString('ModHubSelected', selected);
		}
		for (var v = 0; v < items.length; v++) {
			if (items[v].panel) {
				setShown(items[v].panel, items[v].key === selected);
			}
		}
		var sig = selected + '|' + items.map(function (it) { return it.key; }).join(',');
		if (sig === hubListSig) {
			return;
		}
		hubListSig = sig;
		var old = list.Children() || [];
		for (var o = 0; o < old.length; o++) {
			old[o].DeleteAsync(0);
		}
		items.forEach(function (it) {
			var label = hubListButton(list, it.key, it.entry ? it.title + '  >' : it.title, function () {
				if (it.entry) {
					hubSetOpen(hub, false);
					activate(it.entry);
				} else {
					selectHubItem(hub, it.key);
				}
			});
			var isSelected = it.key === selected;
			label.style.color = isSelected ? '#0b0d0c' : COLOR_TEXT;
			label.button.style.backgroundColor = isSelected ? '#7fe0a0f0' : '#00000000';
		});
	}

	function attachEscapeMenu(top) {
		var row = findOne(top, ['SettingsRow']);
		if (!row) {
			return;
		}
		var menuRoot = escapeMenuRoot(row);
		var parent = row.GetParent();
		if (!menuRoot || !valid(parent)) {
			return;
		}
		var hub = null;
		try {
			hub = ensureHub(menuRoot);
			hubPanel = hub;
			hubMenuRoot = menuRoot;
			if (!valid(parent.FindChildTraverse('ModHubMenuEntry'))) {
				var entry = $.CreatePanel('Button', parent, 'ModHubMenuEntry');
				entry.AddClass('nav_menu_item');
				entry.AddClass('minor');
				var text = $.CreatePanel('Label', entry, '');
				text.AddClass('menuButtonLabel');
				text.text = 'MOD';
				text.hittest = false;
				entry.SetPanelEvent('onactivate', function () {
					var h = menuRoot.FindChildTraverse('ModHubPanel');
					if (valid(h)) {
						hubSetOpen(h, !h.BHasClass('ModHubOpen'));
					}
				});
				try {
					parent.MoveChildBefore(entry, row);
				} catch (e2) {
					// stays at the end of the menu
				}
				log('MOD entry added to the Esc menu (' + (parent.id || 'no id') + ')');
			}
			findExternalEntries(parent);
		} catch (e) {
			log('Esc menu injection failed: ' + e);
			return;
		}
		if (!hubUi || !valid(hubUi.root)) {
			hubUi = buildHubSection(hub);
			hubListSig = '';
			log('Build Auto-Level section added to the MOD hub');
		}
	}

	function renderHub() {
		if (!valid(hubPanel) || !hubPanel.BHasClass('ModHubOpen')) {
			return;
		}
		renderHubList(hubPanel);
		if (!hubUi || !valid(hubUi.root)) {
			return;
		}
		var offBuilds = 0;
		for (var k in settings.buildOff) {
			if (settings.buildOff.hasOwnProperty(k)) {
				offBuilds++;
			}
		}
		setLabel(hubUi.status, 'Status: ' + (gateReason || 'ON') + '      Build in use: ' +
			(buildName ? shortName(buildName) : '?') + '      Builds switched off: ' + offBuilds +
			'      Settings: ' + storageText());
		var b = hubUi.labels;
		setLabel(b.enabled, settings.enabled ? 'ON' : 'OFF');
		b.enabled.button.style.backgroundColor = settings.enabled ? '#2f6b45e0' : COLOR_OFF;
		setLabel(b.bar, settings.showBar ? 'ON' : 'OFF');
		b.bar.button.style.backgroundColor = settings.showBar ? '#2f6b45e0' : COLOR_OFF;
		setLabel(b.pause, manualPause ? 'PAUSED' : 'RUNNING');
		b.pause.button.style.backgroundColor = manualPause ? COLOR_OFF : '#2f6b45e0';
	}

	// ---------------------------------------------------------------- Settings popup survey (dev aid)
	//
	// Writes the structure of the game's Settings popup to the console so the
	// mod's own section can copy its ids, classes and control states.
	var SURVEY_CLASSES = ['SettingsSection', 'SettingsSectionContainer', 'AlwaysActiveSection', 'SettingsSubsection',
		'SettingsSubsectionContainer', 'SubsectionBackground', 'SettingsSectionTitleContainer', 'SettingsSectionTitle',
		'SettingsSectionSubtitle', 'SettingsSubsectionTitleContainer', 'SettingsSubsectionContent',
		'SettingsSectionColumnContainer', 'SettingsSubsectionFirstColumn', 'SettingsSectionColumn', 'SettingsRow',
		'SettingsRowBackground', 'SettingsRowIndicator', 'SettingsRowContent', 'SettingsRowResetButton', 'SettingLabel',
		'SwitchButton', 'SettingValue', 'HorizontalSlider', 'SettingsBody', 'SettingsNavigationButton',
		'SubSectionButton', 'SettingsSubNavigationButton', 'SettingsSubSectionNavigationContainer', 'LeftRightFlow',
		'TopBottomFlow', 'Hidden', 'Active', 'active', 'selected', 'Selected', 'Checked', 'checked', 'On', 'on',
		'IsOn', 'Enabled', 'enabled', 'Disabled', 'disabled', 'NewSetting', 'collapsed', 'Collapsed', 'Expanded'];

	function surveyLine(panel) {
		var text = labelText(panel);
		return (panel.paneltype || '?') + '#' + (panel.id || '') + ' [' + classList(panel, SURVEY_CLASSES) + ']' +
			(text ? ' "' + (text.length > 40 ? text.substring(0, 40) + '..' : text) + '"' : '');
	}

	function surveySettings(top) {
		var body = findOne(top, ['PopupSettingsSettingsBody', 'SettingsBody']);
		if (!body) {
			log('survey: Settings popup not open');
			return;
		}
		var sections = descendantsWithId(body, 'SettingsSection', 30);
		log('survey: body #' + body.id + ', ' + sections.length + ' SettingsSection panels');
		// the last section on the page is "Advanced"
		var target = sections.length ? sections[sections.length - 1] : body;
		var lines = 0;
		var walk = function (panel, depth, prefix) {
			if (!valid(panel) || depth > 9 || lines >= 160) {
				return;
			}
			log('survey ' + prefix + surveyLine(panel));
			lines++;
			var kids = panel.Children() || [];
			for (var i = 0; i < kids.length; i++) {
				walk(kids[i], depth + 1, prefix + '  ');
			}
		};
		walk(target, 0, '');
		// every switch with its label and state classes, to learn the "on" class
		var switches = descendantsWithId(body, 'SwitchButton', 20);
		for (var w = 0; w < switches.length; w++) {
			var owner = switches[w].GetParent();
			var label = valid(owner) ? owner.FindChildTraverse('label') : null;
			log('survey switch "' + labelText(label) + '" button[' + classList(switches[w], SURVEY_CLASSES) +
				'] owner ' + (valid(owner) ? surveyLine(owner) : '-'));
		}
		// sub navigation entries (left column)
		var subs = descendantsWithId(top, 'SubSectionButton', 20);
		for (var n = 0; n < subs.length; n++) {
			log('survey subnav ' + surveyLine(subs[n]) + ' parent ' + surveyLine(subs[n].GetParent()));
		}
	}

	// ---------------------------------------------------------------- reading the HUD

	function tierOf(slot) {
		for (var t = 0; t <= 3; t++) {
			if (has(slot, 'Tier' + t)) {
				return t;
			}
		}
		return -1;
	}

	function pipsOf(slot) {
		var pips = directChild(slot, 'AbilityButton');
		if (!valid(pips)) {
			pips = slot.FindChildTraverse('AbilityButton');
		}
		return valid(pips) ? pips : null;
	}

	// How many upgrades the ability already has, from every signal the HUD offers.
	function upgradeCount(slot, pips) {
		var count = Math.max(tierOf(slot), 0);
		var readOnly = slot.FindChildTraverse('ReadOnlyPipsContainer');
		var shown = 0;
		var owned = 0;
		for (var n = 1; n <= 3; n++) {
			if (valid(readOnly) && has(readOnly.FindChildTraverse('Pip' + n), 'upgraded')) {
				shown++;
			}
			if (pips && has(pips.FindChildTraverse('AbilityUnlock' + n), 'hasAbilityUpgrade')) {
				owned++;
			}
		}
		return Math.max(count, shown, owned);
	}

	function classList(panel, names) {
		var out = [];
		for (var i = 0; i < names.length; i++) {
			if (has(panel, names[i])) {
				out.push(names[i]);
			}
		}
		return out.join(' ');
	}

	// One compact line with every class this script relies on, for bug reports.
	function stateLine(index, slot, pips) {
		var s = 'A' + index + '[' + classList(slot, ['not_trained', 'trained', 'ability_upgradable',
			'ability_upgrade_available', 'can_unlock_ability', 'Tier0', 'Tier1', 'Tier2', 'Tier3']) + ']';
		if (pips) {
			s += ' pips[' + classList(pips, ['isUnlocked', 'canUnlock', 'isReadOnly']) + ']';
			for (var n = 1; n <= 3; n++) {
				s += ' p' + n + '[' + classList(pips.FindChildTraverse('AbilityUnlock' + n),
					['canAffordUpgrade', 'hasAbilityUpgrade', 'canUndo', 'hasAbilityUpgradeAvailable']) + ']';
			}
		} else {
			s += ' no-pips';
		}
		return s;
	}

	// Writes everything the script relies on to the console, for bug reports.
	function debugDump() {
		var top = windowRoot();
		log('---- debug dump v' + VERSION + ' ----');
		log('storage=' + storageKind + ' web ready=' + web.ready + ' failed=' + web.failed + ' queue=' + web.queue.length +
			' settings=' + JSON.stringify(settings));
		log('gate="' + gate() + '" pause="' + manualPause + '" burst=' + (burstUntil ? 'yes' : 'no'));
		log('hero label="' + labelText(top.FindChildTraverse('HeroFavoritesHeaderLabel')) + '"');
		var outer = top.FindChildTraverse('SelectedBuildOuter');
		log('SelectedBuildOuter ' + (valid(outer) ? 'found' : 'missing'));
		try {
			var names = top.FindChildrenWithClassTraverse('SelectedBuildName') || [];
			for (var i = 0; i < names.length && i < 10; i++) {
				log('SelectedBuildName[' + i + ']="' + labelText(names[i]) + '" id=' + names[i].id);
			}
		} catch (e) {
			log('SelectedBuildName lookup threw: ' + e);
		}
		log('learned upgrade=' + learned.upgrade + ' unlock=' + learned.unlock);
		var probes = ['SettingsRow', 'SubOptions', 'FeedbackRow', 'RightSide', 'ModHubMenuEntry', 'ModHubPanel',
			'hero_tools', 'hud_hero_testing_root', 'HeroBuildSelector', 'BuildName'];
		for (var pr = 0; pr < probes.length; pr++) {
			var hits = findAll(top, probes[pr]);
			log('probe ' + probes[pr] + ': ' + hits.length + (hits.length ? ' (first id=' + hits[0].id + ')' : ''));
		}
		log('injected: hub=' + !!(hubUi && valid(hubUi.root)) + ' tools=' +
			!!(toolsUi && valid(toolsUi.root)) + ' buildButtons=' + buildButtons.length +
			' cursorOpen=' + cursorOpen);
		var chain = [['hud', findHud()], ['window', top], ['context', context]];
		for (var c = 0; c < chain.length; c++) {
			log(chain[c][0] + ' id=' + (valid(chain[c][1]) ? chain[c][1].id : '-') + ' classes[' +
				classList(chain[c][1], CURSOR_CLASSES) + '] cursorClassSeen=' + cursorClassSeen);
		}
		for (var sl = 0; sl < slots.length; sl++) {
			if (valid(slots[sl])) {
				log(stateLine(sl + 1, slots[sl], pipsOf(slots[sl])) +
					(hasInside(slots[sl], 'build_suggestion') ? ' <- suggested' : ''));
			}
		}
		log('sandbox=' + sandbox + ' buildRows=' + buildButtons.length);
		try {
			var globalsSeen = Object.getOwnPropertyNames(Function('return this')() || {}).filter(function (n) {
				return /API|Game|UI|Storage|Setting|Convar|Players|Entities|Steam/i.test(n);
			});
			log('globals: ' + globalsSeen.join(', '));
			log('$ members: ' + Object.getOwnPropertyNames($).join(', '));
			['GameInterfaceAPI', 'GameUI', 'Game', 'SteamOverlayAPI', 'UiToolkitAPI'].forEach(function (n) {
				var obj = null;
				try {
					obj = eval(n);
				} catch (e) {
					obj = null;
				}
				if (obj) {
					log(n + ': ' + Object.getOwnPropertyNames(obj).join(', '));
				}
			});
		} catch (eg) {
			log('API listing failed: ' + eg);
		}
		var popups = findAll(top, 'PopupPanel');
		log('build browser: PopupPanel x' + popups.length);
		var selectorsSeen = descendantsWithId(top, 'HeroBuildSelector', 6);
		for (var hs = 0; hs < selectorsSeen.length; hs++) {
			var sel = selectorsSeen[hs];
			var chain = [];
			for (var up = sel.GetParent(), d = 0; valid(up) && d < 6; up = up.GetParent(), d++) {
				chain.push((up.paneltype || '?') + '#' + (up.id || ''));
			}
			log('HeroBuildSelector[' + hs + '] w=' + sel.actuallayoutwidth + ' parents: ' + chain.join(' < '));
			var shown = 0;
			var visitLabels = function (node, depth) {
				if (!valid(node) || depth > 30 || shown >= 12) {
					return;
				}
				var kids = node.Children() || [];
				for (var i = 0; i < kids.length && shown < 12; i++) {
					var t = labelText(kids[i]);
					if (t && kids[i].paneltype === 'Label') {
						shown++;
						log('  label #' + (kids[i].id || '') + ' "' + t + '" in ' + (kids[i].GetParent().paneltype || '?') +
							'#' + (kids[i].GetParent().id || ''));
					}
					visitLabels(kids[i], depth + 1);
				}
			};
			visitLabels(sel, 0);
		}
		log('---- end dump ----');
	}

	// ---------------------------------------------------------------- acting

	function activate(panel) {
		if (!valid(panel)) {
			return false;
		}
		try {
			$.DispatchEvent('Activated', panel, 'mouse');
			return true;
		} catch (e) {
			try {
				$.DispatchEvent('Activated', panel);
				return true;
			} catch (e2) {
				return false;
			}
		}
	}

	// Shows a hidden HUD panel for a moment (fully transparent) so a click on it
	// counts, then puts its style back.
	function withShown(panels, action) {
		for (var i = 0; i < panels.length; i++) {
			if (valid(panels[i])) {
				panels[i].style.opacity = '0';
				panels[i].style.visibility = 'visible';
			}
		}
		$.Schedule(0.05, function () {
			try {
				action();
			} catch (e) {
				log('shown click threw: ' + e);
			}
			$.Schedule(0.1, function () {
				for (var j = 0; j < panels.length; j++) {
					if (valid(panels[j])) {
						panels[j].style.visibility = null;
						panels[j].style.opacity = null;
					}
				}
			});
		});
	}

	function perform(method, kind, slot, pips, tier, index) {
		var pip = pips ? pips.FindChildTraverse('AbilityUnlock' + tier) : null;
		var train = pips ? pips.FindChildTraverse('TrainButton') : null;
		try {
			switch (method) {
			case 'bitsPips':
				$.DispatchEvent('CitadelAbilityUpgradePurchase', pips, tierBit(tier));
				return true;
			case 'bitsPip':
				$.DispatchEvent('CitadelAbilityUpgradePurchase', pip, tierBit(tier));
				return true;
			case 'eventPip':
				$.DispatchEvent('CitadelAbilityUpgradePurchase', pip);
				return true;
			case 'shownPip':
				if (!valid(pip)) {
					return false;
				}
				withShown([pips], function () { activate(pip); });
				return true;
			case 'cmd0':
				$.DispatchEvent('CitadelConCommand', 'upgrade_ability ' + (index - 1));
				return true;
			case 'cmd1':
				$.DispatchEvent('CitadelConCommand', 'upgrade_ability ' + index);
				return true;
			case 'pip':
				return activate(pip);
			case 'train':
				return activate(train);
			case 'icon':
				return activate(slot);
			case 'trainEvent':
				$.DispatchEvent('CitadelTrainButtonActivate', pips);
				return true;
			case 'shownTrain':
				if (!valid(train)) {
					return false;
				}
				withShown([pips, train], function () { activate(train); });
				return true;
			}
		} catch (e) {
			log('method ' + method + ' threw: ' + e);
		}
		return false;
	}

	// Sells back the newest upgrade that is still inside the game's refund window
	// (about 10 s after buying). Several ways are tried, each checked against the
	// ability's upgrade count; the first one the game accepts is kept.
	var UNDO_METHODS = ['eventPip', 'shownClick', 'click', 'eventBits'];
	var undoLearned = -1;
	var pendingUndo = null;

	function refundable(list) {
		for (var i = list.length - 1; i >= 0; i--) {
			var pips = pipsOf(list[i]);
			if (!pips) {
				continue;
			}
			for (var n = 3; n >= 1; n--) {
				var pip = pips.FindChildTraverse('AbilityUnlock' + n);
				if (has(pip, 'canUndo')) {
					return { index: i, tier: n, slot: list[i], pips: pips, pip: pip };
				}
			}
		}
		return null;
	}

	function performUndo(method, target) {
		try {
			switch (method) {
			case 'eventPip':
				$.DispatchEvent('CitadelAbilityUpgradePurchase', target.pip);
				return;
			case 'shownClick':
				withShown([target.pips], function () { activate(target.pip); });
				return;
			case 'click':
				activate(target.pip);
				return;
			case 'eventBits':
				$.DispatchEvent('CitadelAbilityUpgradePurchase', target.pips, tierBit(target.tier));
				return;
			}
		} catch (e) {
			log('undo method ' + method + ' threw: ' + e);
		}
	}

	function startUndo(t, list, root) {
		var target = refundable(list);
		if (!target) {
			toast(root, 'nothing to undo (only upgrades from the last ~10s can be sold back)', false);
			return;
		}
		var wasPaused = manualPause;
		var spentBefore = spentTotal(snapshot());
		pauseAuto('Undo pressed - resumes once you spend that point');
		if (!wasPaused) {
			resumeAtTotal = spentBefore;
		}
		target.before = upgradeCount(target.slot, target.pips);
		target.method = undoLearned >= 0 ? undoLearned : 0;
		target.wasPaused = wasPaused;
		target.deadline = t + 1500;
		pendingUndo = target;
		log('undo: ability ' + (target.index + 1) + ' tier ' + target.tier + ' via ' + UNDO_METHODS[target.method]);
		performUndo(UNDO_METHODS[target.method], target);
	}

	function checkUndo(t, root) {
		var u = pendingUndo;
		if (upgradeCount(u.slot, u.pips) < u.before) {
			if (undoLearned < 0) {
				undoLearned = u.method;
				log('"' + UNDO_METHODS[u.method] + '" works for undo');
			}
			toast(root, 'undone: ability ' + (u.index + 1) + ' tier ' + u.tier + ' - spend that point and auto-level carries on', false);
			lastSeen = snapshot();
			pendingUndo = null;
			return;
		}
		if (t < u.deadline) {
			return;
		}
		u.method++;
		if (undoLearned >= 0 || u.method >= UNDO_METHODS.length || !has(u.pip, 'canUndo')) {
			undoLearned = -1;
			log('undo not accepted by the game');
			toast(root, 'the game did not accept the undo (refund window over?)', false);
			manualPause = u.wasPaused;
			if (!u.wasPaused) {
				resumeAtTotal = -1;
			}
			pendingUndo = null;
			return;
		}
		u.deadline = t + 1500;
		log('undo: trying ' + UNDO_METHODS[u.method]);
		performUndo(UNDO_METHODS[u.method], u);
	}

	// Snapshot of every ability's state, to notice when an action hit the wrong one.
	function snapshot() {
		var out = [];
		for (var i = 0; i < slots.length; i++) {
			var sl = slots[i];
			out.push(valid(sl) ? (has(sl, 'not_trained') ? -1 : upgradeCount(sl, pipsOf(sl))) : -2);
		}
		return out;
	}

	// Pauses when the player changes abilities by hand: any refund, or a point put
	// into an ability other than the one the build (or this script) pointed at.
	// Points spent so far, from a snapshot (-1 = locked, 0..3 = unlocked + upgrades).
	function spentTotal(counts) {
		var total = 0;
		for (var i = 0; i < counts.length; i++) {
			if (counts[i] >= -1) {
				total += counts[i] + 1;
			}
		}
		return total;
	}

	// A refund pauses auto-level until the player has spent that point again
	// (anywhere they like); after that it carries on with the next new point.
	// Upgrading a different ability by hand needs no pause: the build simply
	// continues from there.
	function watchManualChanges(current) {
		if (!lastSeen || lastSeen.length !== current.length) {
			lastSeen = current;
			return;
		}
		for (var i = 0; i < current.length; i++) {
			if (current[i] === -2 || lastSeen[i] === -2) {
				continue;
			}
			if (current[i] < lastSeen[i]) {
				if (!manualPause) {
					pauseAuto('you refunded ability ' + (i + 1) + ' - resumes once you spend that point');
					resumeAtTotal = spentTotal(lastSeen);
				}
				break;
			}
			if (current[i] > lastSeen[i] && i !== lastSuggested && i !== lastActed) {
				log('ability ' + (i + 1) + ' upgraded by hand');
			}
		}
		if (manualPause && resumeAtTotal >= 0 && spentTotal(current) >= resumeAtTotal) {
			resumeAuto('the refunded point was spent again');
		}
		lastSeen = current;
	}

	function currentMethod(kind) {
		var list = METHODS[kind];
		return list[(learned[kind] >= 0 ? learned[kind] : methodIndex[kind]) % list.length];
	}

	// Works out what the build wants next and whether it can be done right now.
	// force (Max now): try even when the HUD does not say the step is affordable;
	// the Sandbox gives unlimited points but never marks pips as affordable.
	function plan(slot, index, force) {
		var pips = pipsOf(slot);
		if (has(pips, 'isReadOnly')) {
			return { wait: 'read-only HUD (spectating)' };
		}
		var name = 'ability ' + index;

		if (has(slot, 'not_trained')) {
			var canUnlock = has(slot, 'ability_upgradable') || has(slot, 'can_unlock_ability') ||
				has(slot, 'canUnlock') || has(pips, 'canUnlock') || has(pips, 'can_unlock_ability');
			if (!canUnlock && !force) {
				return { wait: 'next: unlock ' + name + ' (waiting for an unlock)' };
			}
			return {
				kind: 'unlock',
				label: 'unlock ' + name,
				done: 'unlocked ' + name,
				slot: slot,
				pips: pips,
				tier: 0,
				forced: !canUnlock,
				confirm: function () {
					return !has(slot, 'not_trained') || has(slot, 'trained');
				}
			};
		}

		var before = upgradeCount(slot, pips);
		if (before >= 3) {
			return { wait: name + ' is fully upgraded' };
		}
		var tier = before + 1;
		var pip = pips ? pips.FindChildTraverse('AbilityUnlock' + tier) : null;
		if (has(pip, 'hasAbilityUpgrade') || has(pip, 'canUndo')) {
			return { wait: 'waiting for the game to settle' };
		}
		var affordable = has(pip, 'canAffordUpgrade') || has(slot, 'ability_upgradable') ||
			has(slot, 'ability_upgrade_available');
		if (!affordable && !force) {
			return { wait: 'next: ' + name + ' tier ' + tier + ' (saving points)' };
		}
		return {
			kind: 'upgrade',
			label: 'upgrade ' + name + ' to tier ' + tier,
			done: name + ' upgraded to tier ' + tier,
			slot: slot,
			pips: pips,
			tier: tier,
			forced: !affordable,
			confirm: function () {
				return has(pip, 'hasAbilityUpgrade') || has(pip, 'canUndo') || upgradeCount(slot, pips) > before;
			}
		};
	}

	// "Max now" without a build step: unlock locked abilities first, then raise
	// the lowest one. Returns the slot index to act on, or -1.
	function fallbackSlot(list) {
		var best = -1;
		var bestCount = 99;
		for (var i = 0; i < list.length; i++) {
			var action = plan(list[i], i + 1, true);
			if (action.wait) {
				continue;
			}
			var count = action.kind === 'unlock' ? -1 : upgradeCount(list[i], pipsOf(list[i]));
			if (count < bestCount) {
				best = i;
				bestCount = count;
			}
		}
		return best;
	}

	function onConfirmed(t, root) {
		var kind = pending.kind;
		if (learned[kind] < 0) {
			learned[kind] = methodIndex[kind];
			log('"' + METHOD_NAMES[pending.method] + '" works for ' + kind + 's');
		}
		failedRounds[kind] = 0;
		problem = '';
		lastDone = pending.label;
		log('done: ' + pending.label);
		setStatus(root, 'done: ' + pending.label);
		toast(root, pending.done || pending.label, false);
		lastSeen = snapshot();
		pending = null;
	}

	function onUnconfirmed(t, root) {
		var kind = pending.kind;
		var list = METHODS[kind];
		if (pending.forced) {
			// a forced Max now step proves nothing about the method; most likely no points
			log('Max now: "' + pending.label + '" not accepted, stopping');
			toast(root, 'Max now: the game did not accept "' + pending.label + '" (no points left?)', false);
			burstUntil = 0;
			backoffUntil = t + PIP_RETRY_MS;
			lastSeen = snapshot();
			pending = null;
			return;
		}
		// Did the action land on a different ability? Then the command counts slots differently.
		var after = snapshot();
		for (var i = 0; i < after.length; i++) {
			if (i + 1 !== pending.index && after[i] !== pending.before[i]) {
				log('"' + pending.label + '" changed ability ' + (i + 1) + ' instead (' + pending.method + ')');
				var other = pending.method === 'cmd0' ? 'cmd1' : pending.method === 'cmd1' ? 'cmd0' : '';
				if (other) {
					learned[kind] = list.indexOf(other);
					methodIndex[kind] = learned[kind];
					problem = '';
					backoffUntil = t + NEXT_METHOD_MS;
					setStatus(root, 'upgrade command counts abilities differently; switched to ' + METHOD_NAMES[other]);
					lastSeen = after;
					pending = null;
					return;
				}
			}
		}
		log('no response to "' + pending.label + '" via ' + METHOD_NAMES[pending.method] + ' | ' + lastStateLine);
		if (learned[kind] >= 0) {
			// a method that worked before stopped working; start searching again
			methodIndex[kind] = learned[kind];
			learned[kind] = -1;
		}
		methodIndex[kind] = (methodIndex[kind] + 1) % list.length;
		var next = list[methodIndex[kind]];
		if (methodIndex[kind] === 0) {
			failedRounds[kind]++;
			backoffUntil = t + BACKOFF_MS;
			problem = 'the game ignored all ' + list.length + ' ways to ' + kind + ' (' + failedRounds[kind] +
				'x) - please send a screenshot of this box';
			setStatus(root, 'retrying in 30s');
			toast(root, 'Deadlock did not accept the ' + kind + ' (a game update may have changed it). ' +
				'Retrying every 30s - spend points manually meanwhile.', true);
		} else {
			// a late upgrade must never meet a second click inside the refund window
			backoffUntil = t + (kind === 'upgrade' ? PIP_RETRY_MS : NEXT_METHOD_MS);
			setStatus(root, 'no response via ' + METHOD_NAMES[pending.method] + ', trying ' + METHOD_NAMES[next]);
		}
		lastSeen = after;
		pending = null;
	}

	function step() {
		var t = now();
		var root = findHud();
		if (!root) {
			return;
		}
		if (!claimOwnership(root, t)) {
			return; // the owning copy shows the panel; touching it here would hide it
		}
		if (!settingsLoaded) {
			loadSettings();
		}
		attachAll(t);
		watchHub(t);
		webTick(t);
		var list = findSlots(root);
		if (list.length !== SLOT_COUNT) {
			hideStatus(root);
			hidePanel(root);
			return; // main menu, loading, hero select
		}
		refreshNames(t);
		if (settings.showBar && !sandbox && cursorScreenOpen(root)) {
			showPanel(root);
		} else {
			hidePanel(root);
		}
		if (!DEBUG_STATUS && toastUntil > 0 && t > toastUntil) {
			toastUntil = 0;
			hideStatus(root);
		}

		if (pending) {
			if (pending.confirm()) {
				onConfirmed(t, root);
				return; // let the HUD settle for one tick
			}
			if (t < pending.deadline) {
				return;
			}
			onUnconfirmed(t, root);
			return;
		}

		if (pendingUndo) {
			checkUndo(t, root);
			renderUi();
			return;
		}
		if (undoRequested) {
			undoRequested = false;
			startUndo(t, list, root);
			renderUi();
			return;
		}

		var suggested = -1;
		for (var i = 0; i < list.length; i++) {
			if (hasInside(list[i], 'build_suggestion')) {
				suggested = i;
				break;
			}
		}

		watchManualChanges(snapshot());
		lastSuggested = suggested;

		var bursting = burstUntil > 0;
		if (bursting && t > burstUntil) {
			burstUntil = 0;
			bursting = false;
		}
		gateReason = bursting ? '' : gate();
		renderUi();
		if (gateReason) {
			setStatus(root, gateReason);
			return;
		}

		if (suggested < 0 && bursting) {
			suggested = fallbackSlot(list);
		}
		if (suggested < 0) {
			lastStateLine = '';
			if (bursting && ++burstIdle > 4) {
				burstUntil = 0;
				toast(root, 'Max now: nothing more to spend', false);
			}
			setStatus(root, lastDone ? 'waiting for the next point (last: ' + lastDone + ')' :
				'no next step from your build (is a build with an ability order selected?)');
			return;
		}

		var slot = list[suggested];
		var pips = pipsOf(slot);
		var line = stateLine(suggested + 1, slot, pips);
		if (line !== lastStateLine) {
			lastStateLine = line;
			log('state ' + line);
		}

		var action = plan(slot, suggested + 1, bursting);
		if (action.wait) {
			if (bursting) {
				// the build's next step is not affordable; spend on something else
				var other = fallbackSlot(list);
				if (other < 0) {
					if (++burstIdle > 4) {
						burstUntil = 0;
						toast(root, 'Max now: nothing more to spend', false);
					}
					return;
				}
				suggested = other;
				slot = list[other];
				pips = pipsOf(slot);
				action = plan(slot, other + 1, true);
			} else {
				plannedLabel = '';
				setStatus(root, action.wait);
				return;
			}
		}
		burstIdle = 0;
		if (t < backoffUntil) {
			return;
		}
		if (!bursting && settings.delay > 0) {
			if (plannedLabel !== action.label) {
				plannedLabel = action.label;
				plannedSince = t;
			}
			if (t - plannedSince < settings.delay * 1000) {
				setStatus(root, action.label + ' in ' + Math.ceil((settings.delay * 1000 - (t - plannedSince)) / 1000) + 's');
				return;
			}
		}
		plannedLabel = '';
		var method = currentMethod(action.kind);
		var before = snapshot();
		if (perform(method, action.kind, slot, pips, action.tier, suggested + 1)) {
			actions++;
			lastActed = suggested;
			pending = {
				kind: action.kind,
				label: action.label,
				done: action.done,
				method: method,
				index: suggested + 1,
				before: before,
				forced: !!action.forced,
				confirm: action.confirm,
				deadline: t + CONFIRM_TIMEOUT_MS + 200
			};
			if (actions <= 60) {
				log(action.label + ' via ' + METHOD_NAMES[method]);
			}
			setStatus(root, action.label + ' (' + METHOD_NAMES[method] + ')');
		} else {
			methodIndex[action.kind] = (methodIndex[action.kind] + 1) % METHODS[action.kind].length;
		}
	}

	function tick() {
		if (!valid(context)) {
			return; // layout unloaded; another copy takes over
		}
		try {
			step();
		} catch (e) {
			log('error: ' + e);
		}
		$.Schedule(TICK_SECONDS, tick);
	}

	try {
		$.RegisterForUnhandledEvent('CitadelGameStateChanged', function () {
			slots = [];
			pending = null;
			backoffUntil = 0;
			lastStateLine = '';
			lastDone = '';
			burstUntil = 0;
			lastActed = -1;
			resumeAuto('game state changed');
		});
	} catch (e) {
		// the validity checks cover clients without this event
	}

	log('v' + VERSION + ' loaded from ' + (context && context.id ? context.id : 'layout'));
	$.Schedule(1.0, tick);
})();
