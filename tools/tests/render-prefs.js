#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Renders preferences dialog into Xvfb for visual layout verification
 * (without GNOME Shell or affecting running session).
 *
 *   Xvfb :99 -screen 0 900x800x24 &
 *   GSETTINGS_SCHEMA_DIR=schemas DISPLAY=:99 \
 *     gjs tools/tests/render-prefs.js "$PWD" /tmp/prefs.png 640 520
 */

imports.gi.versions.Gtk = '4.0';
imports.gi.versions.Soup = '3.0';

const {Adw, GLib, Gtk} = imports.gi;
const System = imports.system;


const REPO = ARGV[0] || '.';
const OUT = ARGV[1] || '/tmp/prefs.png';
const W = parseInt(ARGV[2] || '640', 10);
const H = parseInt(ARGV[3] || '520', 10);

imports.searchPath.push(REPO);
imports.searchPath.push(REPO + '/tools/tests/harness');

const misc = imports.misc; // loads extensionUtils stub

Adw.init();

const Prefs = imports.prefs;
const win = new Adw.PreferencesWindow({default_width: W, default_height: H});
win.set_title('Settings — Home Assistant & Music Assistant');
Prefs.fillPreferencesWindow(win);
win.present();

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
print(`window ${W}x${H} rendered (6 s) - screenshot: ${OUT}`);
System.exit(0);
