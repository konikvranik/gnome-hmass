#!/usr/bin/env python3
"""Mock servery pro E2E test rozšíření (Home Assistant + Music Assistant protokoly).

Použití: python3 mock_server.py <ha|ma> <port> <log_soubor>
"""
import base64
import hashlib
import json
import os
import re
import socket
import struct
import sys
import threading
import time
from datetime import datetime, timezone

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def recvn(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf += chunk
    return buf


def read_frame(sock):
    b1, b2 = recvn(sock, 2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    ln = b2 & 0x7F
    if ln == 126:
        ln = struct.unpack(">H", recvn(sock, 2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", recvn(sock, 8))[0]
    mask = recvn(sock, 4) if masked else None
    data = recvn(sock, ln)
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def send_frame(sock, payload, opcode=1):
    data = payload.encode()
    hdr = bytes([0x80 | opcode])
    n = len(data)
    if n < 126:
        hdr += bytes([n])
    elif n < 65536:
        hdr += bytes([126]) + struct.pack(">H", n)
    else:
        hdr += bytes([127]) + struct.pack(">Q", n)
    sock.sendall(hdr + data)


def handshake(sock):
    req = b""
    while b"\r\n\r\n" not in req:
        req += sock.recv(4096)
    m = re.search(rb"Sec-WebSocket-Key: (.+?)\r\n", req)
    key = m.group(1).decode()
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    sock.sendall(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode()
    )


def serve(mode, port, logfile):
    scenario = os.environ.get("HM_MOCK_SCENARIO", "")
    die_armed = []
    states = {
        "sensor.teplota_ob-yvak": {
            "entity_id": "sensor.teplota_ob-yvak",
            "state": "21.4",
            "attributes": {"friendly_name": "Teplota obýváku", "unit_of_measurement": "°C"},
        },
        "input_boolean.svetlo": {
            "entity_id": "input_boolean.svetlo",
            "state": "on",
            "attributes": {"friendly_name": "Světlo"},
        },
        "input_number.jas": {
            "entity_id": "input_number.jas",
            "state": "42",
            "attributes": {"friendly_name": "Jas", "min": 0, "max": 100, "step": 1},
        },
        "media_player.obyvak": {
            "entity_id": "media_player.obyvak",
            "state": "playing",
            "attributes": {
                "friendly_name": "Obývák",
                "volume_level": 0.4,
                "is_volume_muted": False,
                "media_title": "Rádio FM",
                "media_artist": "Interpret",
                "media_album_name": "Album Y",
                "media_duration": 600,
                "media_position": 30,
                "media_position_updated_at": datetime.now(timezone.utc).isoformat(),
                "shuffle": False,
                "repeat": "off",
            },
        },
        "media_player.loznice": {
            "entity_id": "media_player.loznice",
            "state": "paused",
            "attributes": {
                "friendly_name": "Ložnice",
                "volume_level": 0.15,
                "is_volume_muted": False,
                "media_title": "Píseň",
                "media_duration": 200,
                "media_position": 12,
                "media_position_updated_at": datetime.now(timezone.utc).isoformat(),
            },
        },
    }

    def log(kind, obj):
        with open(logfile, "a") as f:
            f.write(json.dumps({"kind": kind, "data": obj}) + "\n")

    def on_conn(sock):
        handshake(sock)
        try:
            if mode == "ha":
                ha_flow(sock)
            else:
                ma_flow(sock)
        except (ConnectionError, OSError):
            pass
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def ha_flow(sock):
        send_frame(sock, json.dumps({"type": "auth_required", "ha_version": "2026.9.0"}))
        while True:
            opcode, data = read_frame(sock)
            if opcode == 8:
                break
            if opcode != 1:
                continue
            m = json.loads(data)
            if scenario == "reject" and m.get("type") == "auth":
                # neautentizovaný klient dostane event i odmítnutí, pak close
                send_frame(sock, json.dumps({
                    "type": "event",
                    "event": {"event_type": "state_changed",
                              "data": {"entity_id": "sensor.x", "new_state": None}},
                }))
                send_frame(sock, json.dumps({
                    "type": "auth_invalid", "message": "Invalid access token",
                }))
                sock.close()
                return
            if m.get("type") == "auth":
                send_frame(sock, json.dumps({"type": "auth_ok", "ha_version": "2026.9.0"}))
            elif m.get("type") == "get_states":
                send_frame(sock, json.dumps({
                    "id": m["id"], "type": "result", "success": True,
                    "result": list(states.values()),
                }))
            elif m.get("type") == "subscribe_events":
                send_frame(sock, json.dumps({
                    "id": m["id"], "type": "result", "success": True, "result": None,
                }))

                def push_change():
                    time.sleep(0.5)
                    st = dict(states["sensor.teplota_ob-yvak"])
                    st["state"] = "22.5"
                    send_frame(sock, json.dumps({
                        "id": m["id"], "type": "event",
                        "event": {"event_type": "state_changed",
                                  "data": {"entity_id": st["entity_id"],
                                           "new_state": st, "old_state": st}},
                    }))

                threading.Thread(target=push_change, daemon=True).start()
            elif m.get("type") == "call_service":
                log("ha_call", m)
                send_frame(sock, json.dumps({
                    "id": m["id"], "type": "result", "success": True, "result": {},
                }))

    def ma_flow(sock):
        if scenario == "garbage":
            # zlobivý server: nevalidní JSON, události bez dat, abrupt close
            for _ in range(4):
                send_frame(sock, "{ toto neni json ")
                send_frame(sock, json.dumps({"event": "player_updated", "data": None}))
                send_frame(sock, json.dumps({"event": "queue_updated",
                                             "data": {"queue_id": None}}))
                send_frame(sock, json.dumps({"message_id": "neznamy",
                                             "result": [{"player_id": "p1"}, None]}))
            sock.close()
            return
        if scenario == "die" and not die_armed:
            # normální chování, ale proces (i listen socket) za 2.5 s skončí
            die_armed.append(True)
            threading.Timer(2.5, os._exit, args=(0,)).start()
        send_frame(sock, json.dumps({
            "server_id": "mock", "server_version": "2.10.4", "schema_version": 1,
            "onboard_done": True, "name": "MockMA",
        }))
        players = [
            {"player_id": "p1", "name": "Obývák", "playback_state": "playing",
             "volume_level": 40, "volume_muted": False, "powered": True,
             "available": True},
            {"player_id": "p2", "name": "Kuchyň", "playback_state": "idle",
             "volume_level": 10, "volume_muted": False, "powered": False,
             "available": True},
        ]
        def queue_for(pid):
            if pid == "p2":
                return {
                    "queue_id": "p2", "active": True, "display_name": "Kuchyň",
                    "available": True, "items": 0, "shuffle_enabled": False,
                    "repeat_mode": "off", "current_index": None, "elapsed_time": 0,
                    "elapsed_time_last_updated": time.time(), "playback_speed": 1.0,
                    "state": "idle", "current_item": None,
                }
            return {
                "queue_id": "p1", "active": True, "display_name": "Obývák",
                "available": True, "items": 5, "shuffle_enabled": True,
                "repeat_mode": "one", "current_index": 0, "elapsed_time": 10.0,
                "elapsed_time_last_updated": time.time(), "playback_speed": 1.0,
                "state": "playing",
                "current_item": {
                    "queue_id": "p1", "queue_item_id": "qi1", "name": "Artist - Song A",
                    "duration": 200, "index": 0,
                    "media_item": {"name": "Song A", "artists": [{"name": "Artist"}],
                                   "album": {"name": "Album X"}},
                },
            }
        while True:
            opcode, data = read_frame(sock)
            if opcode == 8:
                break
            if opcode != 1:
                continue
            m = json.loads(data)
            cmd = m.get("command", "")
            mid = m.get("message_id")
            if cmd == "auth":
                send_frame(sock, json.dumps({"message_id": mid, "result": {"user_id": "u1"}}))
            elif cmd == "players/all":
                send_frame(sock, json.dumps({"message_id": mid, "result": players}))
            elif cmd == "player_queues/get_active_queue":
                pid = m.get("args", {}).get("player_id", "p1")
                send_frame(sock, json.dumps({"message_id": mid, "result": queue_for(pid)}))

                if pid == "p1":
                    def push_events():
                        time.sleep(0.5)
                        send_frame(sock, json.dumps({
                            "event": "queue_time_updated", "object_id": "p1", "data": 11.0}))
                        time.sleep(0.3)
                        q2 = queue_for("p1")
                        q2["state"] = "paused"
                        send_frame(sock, json.dumps({
                            "event": "queue_updated", "object_id": "p1", "data": q2}))
                        time.sleep(0.3)
                        send_frame(sock, json.dumps({
                            "event": "player_updated", "object_id": "p1",
                            "data": dict(players[0], volume_level=55)}))

                    threading.Thread(target=push_events, daemon=True).start()
            else:
                log("ma_cmd", m)
                send_frame(sock, json.dumps({"message_id": mid, "result": None}))

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(4)
    print(f"mock {mode} listening on {port}", flush=True)
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=on_conn, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    serve(sys.argv[1], int(sys.argv[2]), sys.argv[3])
