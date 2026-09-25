#!/usr/bin/env gjs
// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Vykreslí nastavovací dialog do Xvfb pro vizuální kontrolu layoutu
 * (bez GNOME Shell i bez zásahu do běžícího sezení).
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

const misc = imports.misc; // načte stub extensionUtils

Adw.init();

const Prefs = imports.prefs;
const win = new Adw.PreferencesWindow({default_width: W, default_height: H});
win.set_title('Nastavení — Home Assistant & Music Assistant');
Prefs.fillPreferencesWindow(win);
win.present();

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
print(`okno ${W}x${H} vykresleno (6 s) - snimek: ${OUT}`);
System.exit(0);
