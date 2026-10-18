function () {
	'use strict';

	var VERSION = '1.0';
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

	var OWNER_ATTR = 'BuildAutoLevelOwner';
	var STATUS_ID = 'BuildAutoLevelStatus';

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

	// Snapshot of every ability's state, to notice when an action hit the wrong one.
	function snapshot() {
		var out = [];
		for (var i = 0; i < slots.length; i++) {
			var sl = slots[i];
			out.push(valid(sl) ? (has(sl, 'not_trained') ? -1 : upgradeCount(sl, pipsOf(sl))) : -2);
		}
		return out;
	}

	function currentMethod(kind) {
		var list = METHODS[kind];
		return list[(learned[kind] >= 0 ? learned[kind] : methodIndex[kind]) % list.length];
	}

	// Works out what the build wants next and whether it can be done right now.
	function plan(slot, index) {
		var pips = pipsOf(slot);
		if (has(pips, 'isReadOnly')) {
			return { wait: 'read-only HUD (spectating)' };
		}
		var name = 'ability ' + index;

		if (has(slot, 'not_trained')) {
			var canUnlock = has(slot, 'ability_upgradable') || has(slot, 'can_unlock_ability') ||
				has(slot, 'canUnlock') || has(pips, 'canUnlock') || has(pips, 'can_unlock_ability');
			if (!canUnlock) {
				return { wait: 'next: unlock ' + name + ' (waiting for an unlock)' };
			}
			return {
				kind: 'unlock',
				label: 'unlock ' + name,
				done: 'unlocked ' + name,
				slot: slot,
				pips: pips,
				tier: 0,
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
		if (!affordable) {
			return { wait: 'next: ' + name + ' tier ' + tier + ' (saving points)' };
		}
		return {
			kind: 'upgrade',
			label: 'upgrade ' + name + ' to tier ' + tier,
			done: name + ' upgraded to tier ' + tier,
			slot: slot,
			pips: pips,
			tier: tier,
			confirm: function () {
				return has(pip, 'hasAbilityUpgrade') || has(pip, 'canUndo') || upgradeCount(slot, pips) > before;
			}
		};
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
		pending = null;
	}

	function onUnconfirmed(t, root) {
		var kind = pending.kind;
		var list = METHODS[kind];
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
		pending = null;
	}

	function step() {
		var t = now();
		var root = findHud();
		if (!root) {
			return;
		}
		if (!claimOwnership(root, t)) {
			return;
		}
		var list = findSlots(root);
		if (list.length !== SLOT_COUNT) {
			hideStatus(root);
			return; // main menu, hideout, loading, hero select
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

		var suggested = -1;
		for (var i = 0; i < list.length; i++) {
			if (hasInside(list[i], 'build_suggestion')) {
				suggested = i;
				break;
			}
		}
		if (suggested < 0) {
			lastStateLine = '';
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

		var action = plan(slot, suggested + 1);
		if (action.wait) {
			setStatus(root, action.wait);
			return;
		}
		if (t < backoffUntil) {
			return;
		}
		var method = currentMethod(action.kind);
		var before = snapshot();
		if (perform(method, action.kind, slot, pips, action.tier, suggested + 1)) {
			actions++;
			pending = {
				kind: action.kind,
				label: action.label,
				done: action.done,
				method: method,
				index: suggested + 1,
				before: before,
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
		});
	} catch (e) {
		// the validity checks cover clients without this event
	}

	log('v' + VERSION + ' loaded from ' + (context && context.id ? context.id : 'layout'));
	$.Schedule(1.0, tick);
})();
