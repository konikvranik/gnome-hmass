// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 pvranik
//
/*
 * Klient WebSocket API Home Assistant.
 * https://developers.home-assistant.io/docs/api/websocket
 */

const Me = imports.misc.extensionUtils.getCurrentExtension();
const WsLib = Me.imports.lib.ws;

var HAClient = class HAClient {
    constructor() {
        this.states = {}; // entity_id -> objekt stavu {entity_id, state, attributes}
        // agent + jazyk preferované Assist pipeline (voice / HA PWA chovají stejně)
        this.assistAgentId = null;   // např. conversation.google_ai_conversation_2
        this.assistLanguage = null;  // např. "*" nebo "cs"

        this.onstate = null;  // (statusText, detail) - 'ok' | 'connecting' | 'error' | 'auth-error'
        this.onstates = null; // (states) - kompletní výpis po přihlášení
        this.onentity = null; // (entityId, stateObj|null)

        this._status = 'connecting';
        this._token = '';
        this._cmdId = 0;
        this._getStatesId = 0;
        this._pipelinesId = 0;
        this._pendingRequests = new Map(); // id -> {resolve, reject}

        this._ws = new WsLib.WsClient('homeassistant');
        this._ws.onopen = () => {
            // HA první pošle auth_required; čekáme na něj v onmessage
        };
        this._ws.onstate = (st, detail) => {
            if (st === WsLib.State.CONNECTING) {
                this._setStatus('connecting', detail);
            } else if (st === WsLib.State.DISCONNECTED) {
                this._rejectPending(new Error(detail || 'bez spojení'));
                // auth-error zůstává vidět, dokud uživatel nezmění token
                if (this._status !== 'auth-error')
                    this._setStatus('error', detail || 'bez spojení');
            }
        };
        this._ws.onmessage = msg => this._onMessage(msg);
    }

    _setStatus(status, detail) {
        this._status = status;
        if (this.onstate)
            this.onstate(status, detail);
    }

    get status() {
        return this._status;
    }

    configure(url, token, allowInsecure) {
        this._url = (url || '').trim();
        this._token = token || '';
        const wsUrl = WsLib.wsUrlFromHttp(url, '/api/websocket');
        this._ws.setTarget([wsUrl], this._token, allowInsecure);
    }

    connect() {
        this._ws.open();
        this._setStatus('connecting', '');
    }

    disconnect() {
        this._ws.close();
        this.states = {};
        this._setStatus('disconnected', '');
        this._rejectPending(new Error('Odpojeno'));
    }

    reconnect() {
        this._ws.reconnect();
        this._setStatus('connecting', '');
    }

    destroy() {
        this._ws.destroy();
        this._rejectPending(new Error('Zničeno'));
    }

    _rejectPending(err) {
        for (const {reject} of this._pendingRequests.values()) {
            try {
                reject(err);
            } catch (e) {
                // ignore
            }
        }
        this._pendingRequests.clear();
    }

    _nextId() {
        this._cmdId += 1;
        return this._cmdId;
    }

    _onMessage(msg) {
        if (!msg || typeof msg !== 'object')
            return;
        switch (msg.type) {
            case 'auth_required':
                this._ws.send({type: 'auth', access_token: this._token});
                break;
            case 'auth_ok':
                this._setStatus('ok', `HA ${msg.ha_version || ''}`.trim());
                this._initialFetch();
                break;
            case 'auth_invalid':
                log(`[homeassistant] přihlášení odmítnuto: ${msg.message || 'neplatný token'}`);
                this._setStatus('auth-error', msg.message || 'neplatný token');
                // auth chyba je deterministická - bez reconnect smyčky,
                // nový pokus až po změně nastavení
                this._ws.close();
                break;
            case 'result':
                this._onResult(msg);
                if (this._pendingRequests.has(msg.id)) {
                    const {resolve, reject} = this._pendingRequests.get(msg.id);
                    this._pendingRequests.delete(msg.id);
                    if (msg.success) {
                        const res = msg.result || {};
                        const resp = res.response || {};
                        const speech = (resp.speech && resp.speech.plain && resp.speech.plain.speech) || '';
                        resolve({
                            speech,
                            conversationId: res.conversation_id || null,
                            responseType: resp.response_type || '',
                            raw: res,
                        });
                    } else {
                        const err = msg.error || {};
                        reject(new Error(err.message || 'Chyba serveru Home Assistant'));
                    }
                }
                break;
            case 'event':
                if (msg.event && msg.event.event_type === 'state_changed')
                    this._onStateChanged(msg.event.data);
                break;
            default:
                break;
        }
    }

    _initialFetch() {
        this._getStatesId = this._nextId();
        this._ws.send({id: this._getStatesId, type: 'get_states'});
        this._ws.send({
            id: this._nextId(),
            type: 'subscribe_events',
            event_type: 'state_changed',
        });
        // informace o preferované Assist pipeline (agent + jazyk pro conversation/process)
        this._pipelinesId = this._nextId();
        this._ws.send({id: this._pipelinesId, type: 'assist_pipeline/pipeline/list'});
    }

    _onResult(msg) {
        if (msg.id === this._pipelinesId) {
            this._applyPipelines(msg.success ? msg.result : null);
            return;
        }
        if (msg.id !== this._getStatesId || !msg.success)
            return;
        this.states = {};
        for (const st of msg.result || []) {
            if (st && st.entity_id)
                this.states[st.entity_id] = st;
        }
        if (this.onstates)
            this.onstates(this.states);
    }

    /**
     * Z preferované Assist pipeline převezme agenta a jazyk konverzace,
     * aby Assist chat odpovídal stejně jako voice asistent / HA aplikace.
     */
    _applyPipelines(result) {
        this.assistAgentId = null;
        this.assistLanguage = null;
        if (!result || !Array.isArray(result.pipelines) || result.pipelines.length === 0)
            return;
        const preferred = result.pipelines.find(p => p && p.id === result.preferred_pipeline) ||
            result.pipelines[0];
        if (preferred.conversation_engine)
            this.assistAgentId = preferred.conversation_engine;
        if (preferred.conversation_language)
            this.assistLanguage = preferred.conversation_language;
        else if (preferred.language)
            this.assistLanguage = preferred.language;
    }

    _onStateChanged(data) {
        const entityId = data.entity_id;
        const newState = data.new_state || null;
        if (newState)
            this.states[entityId] = newState;
        else
            delete this.states[entityId];
        if (this.onentity)
            this.onentity(entityId, newState);
    }

    callService(domain, service, serviceData) {
        if (!this._ws.connected)
            return;
        this._ws.send({
            id: this._nextId(),
            type: 'call_service',
            domain,
            service,
            service_data: serviceData || {},
        });
    }

    /**
     * Zpracuje textový příkaz přes Home Assistant Assist (Conversation API).
     * Ve výchozím nastavení se použije agent a jazyk z preferované Assist
     * pipeline - jako u voice asistenta a v HA aplikaci. Bez agent_id by HA
     * použila vestavěného agenta, který nemusí rozumět stejným frázím.
     * @param {string} text - text příkazu nebo otázky
     * @param {string|null} conversationId - volitelné ID běžící konverzace
     * @param {string|null} language - jazyk; null = z pipeline (fallback cs)
     * @param {string|null} agentId - agent; null = z pipeline (fallback výchozí agent HA)
     * @returns {Promise<{speech: string, conversationId: string|null, responseType: string, raw: object}>}
     */
    processConversation(text, conversationId = null, language = null, agentId = null) {
        return new Promise((resolve, reject) => {
            if (!this._ws.connected) {
                reject(new Error('Home Assistant není připojen'));
                return;
            }
            const id = this._nextId();
            const payload = {
                id,
                type: 'conversation/process',
                text,
                language: language || this.assistLanguage || 'cs',
            };
            if (conversationId)
                payload.conversation_id = conversationId;
            const agent = agentId || this.assistAgentId;
            if (agent)
                payload.agent_id = agent;

            this._pendingRequests.set(id, {resolve, reject});
            this._ws.send(payload);
        });
    }
};
