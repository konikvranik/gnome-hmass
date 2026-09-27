// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 konikvranik
//
/*
 * Home Assistant WebSocket API client.
 * https://developers.home-assistant.io/docs/api/websocket
 */

import * as WsLib from './ws.js';
import {_} from './i18n.js';

export class HAClient {
    constructor() {
        this.states = {}; // entity_id -> state object {entity_id, state, attributes}
        // agent + language of preferred Assist pipeline (voice / HA PWA behave identically)
        this.assistAgentId = null;   // e.g. conversation.google_ai_conversation_2
        this.assistLanguage = null;  // e.g. "*" or "en"

        this.onstate = null;  // (statusText, detail) - 'ok' | 'connecting' | 'error' | 'auth-error'
        this.onstates = null; // (states) - full states dump after authentication
        this.onentity = null; // (entityId, stateObj|null)

        this._status = 'connecting';
        this._token = '';
        this._cmdId = 0;
        this._getStatesId = 0;
        this._pipelinesId = 0;
        this._pendingRequests = new Map(); // id -> {resolve, reject}

        this._ws = new WsLib.WsClient('homeassistant');
        this._ws.onopen = () => {
            // HA sends auth_required first; handled in onmessage
        };
        this._ws.onstate = (st, detail) => {
            if (st === WsLib.State.CONNECTING) {
                this._setStatus('connecting', detail);
            } else if (st === WsLib.State.DISCONNECTED) {
                this._rejectPending(new Error(detail || _('no connection')));
                // auth-error remains visible until the user updates the token
                if (this._status !== 'auth-error')
                    this._setStatus('error', detail || _('no connection'));
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
        this._rejectPending(new Error(_('disconnected')));
    }

    reconnect() {
        this._ws.reconnect();
        this._setStatus('connecting', '');
    }

    destroy() {
        this._ws.destroy();
        this._rejectPending(new Error(_('destroyed')));
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
                log(`[homeassistant] login rejected: ${msg.message || 'invalid token'}`);
                this._setStatus('auth-error', msg.message || _('invalid token'));
                // auth error is deterministic - no reconnect loop,
                // retry only after settings change
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
                        reject(new Error(err.message || 'Home Assistant server error'));
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
        // info about preferred Assist pipeline (agent + language for conversation/process)
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
     * Adopts agent and conversation language from preferred Assist pipeline,
     * so that Assist chat responds identically to voice assistant / HA app.
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
     * Processes a text command via Home Assistant Assist (Conversation API).
     * Uses agent and language from the preferred Assist pipeline by default,
     * matching the voice assistant and HA application behavior.
     * @param {string} text - command or query text
     * @param {string|null} conversationId - optional ID of ongoing conversation
     * @param {string|null} language - language; null = from pipeline (fallback cs)
     * @param {string|null} agentId - agent; null = from pipeline (fallback default HA agent)
     * @returns {Promise<{speech: string, conversationId: string|null, responseType: string, raw: object}>}
     */
    processConversation(text, conversationId = null, language = null, agentId = null) {
        return new Promise((resolve, reject) => {
            if (!this._ws.connected) {
                reject(new Error(_('Home Assistant is not connected')));
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
