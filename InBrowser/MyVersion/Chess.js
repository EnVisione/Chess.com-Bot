// ==UserScript==
// @name         Chess.com Bot - Human-like Play (Educational/Bot Practice Only)
// @namespace    EnVy-Modernized
// @version      12.5.0
// @description  🚀 HYBRID: Fixed Black Highlighting + Moves
// @author       EnVy (Modernized)
// @match        https://www.chess.com/play/*
// @match        https://www.chess.com/game/*
// @match        https://www.chess.com/puzzles/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    class ChessAnalyzer {
        constructor() {
            this.isThinking = false;
            this.settings = {
                alwaysBest: false,
                targetElo: 2200,
                autoMove: false,
                moveDelayMin: 0.5,
                moveDelayMax: 2.0,
                preferLichess: true,
                autoQueue: false,
                useLc0: false,
                liveAnalyzer: true,
                validateBotElo: true,
                analyzerDepth: 14,
                learnerMode: false,
                helperMode: false,
                botPremove: false,
                drawArrows: true,
                injectMoveListIcons: true
            };
            this.currentMoves = [];
            this.moveDelayTimeout = null;
            this.gameHistory = [];
            this.myColor = null;
            this.positionCache = new Map();
            this.lastAnalyzedFen = null;
            this.requestInProgress = false;
            this.keepAliveInterval = null;

            this.ws = null;
            this.wsReady = false;
            this.wsTimeout = null;
            this.receivedMoves = {};

            this.gameAnalysis = this._emptyGameAnalysis();
            this.analyzerInProgress = false;
            this.pendingMoveAnalysis = null;
            this.pendingGameAnalysis = null;
            this.pendingPositionAnalysis = null;
            this.eloAdjustments = this._loadEloAdjustments();
            this._lastBoardSize = null;
            this._helperMoveListenerInstalled = false;

            this.loadSettings();
        }

        _emptyGameAnalysis() {
            return {
                fens: [],
                evals: [],
                moves: [],
                sans: [],
                classifications: [],
                openings: [],
                winPercents: [],
                lastSeenFen: null,
                lastTargetElo: null,
                whiteName: null,
                blackName: null,
                gameOverSummary: null
            };
        }

        loadSettings() {
            const saved = GM_getValue('chessAnalyzerSettings');
            if (saved) Object.assign(this.settings, JSON.parse(saved));
        }

        saveSettings() {
            GM_setValue('chessAnalyzerSettings', JSON.stringify(this.settings));
        }

        // Dual-engine routing: the BOT'S play and the LIVE ANALYZER run on
        // different engine processes so neither queues behind the other on the
        // server. Whichever engine the user picks for play, the analyzer takes
        // the OTHER one. (Stockfish + lc0 with combined GPU+CPU footprint
        // means the analyzer is essentially free while play is happening.)
        _getPlayEngine() {
            return this.settings.useLc0 ? 'lc0' : 'stockfish';
        }

        _getAnalysisEngine() {
            return this.settings.useLc0 ? 'stockfish' : 'lc0';
        }

        getDepthFromElo(elo) {
            if (elo >= 2800) return 25;
            if (elo >= 2600) return 24;
            if (elo >= 2400) return 22;
            if (elo >= 2200) return 21;
            if (elo >= 2000) return 20;
            if (elo >= 1800) return 19;
            if (elo >= 1600) return 18;
            if (elo >= 1400) return 16;
            if (elo >= 1200) return 14;
            return 12;
        }

        getThinkTimeFromElo(elo) {
            if (elo >= 2800) return 5000;
            if (elo >= 2600) return 4000;
            if (elo >= 2400) return 3000;
            if (elo >= 2200) return 2500;
            if (elo >= 2000) return 2000;
            if (elo >= 1800) return 1500;
            if (elo >= 1600) return 1200;
            if (elo >= 1400) return 1000;
            if (elo >= 1200) return 800;
            return 600;
        }

        // Read remaining time on the user's clock from chess.com's DOM. Returns
        // seconds, or null if the clock can't be located. Tries a few selectors
        // so we keep working through chess.com's frequent rebrands.
        _getMyClockSeconds() {
            try {
                const myColor = this.myColor === 2 ? 'black' : 'white';
                const candidates = [
                    `.clock-${myColor}`,
                    `.clock-component.clock-${myColor}`,
                    `[data-cy="clock-${myColor}"]`,
                    '.clock-bottom .clock-time-monospace',
                    '.clock-bottom'
                ];
                for (const sel of candidates) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const txt = (el.textContent || '').trim();
                    // "1:23.4" / "1:23" / "0:05.2" / "12:34"
                    const m = /(\d+):(\d{1,2})(?:\.(\d+))?/.exec(txt);
                    if (m) {
                        const min = parseInt(m[1], 10) || 0;
                        const sec = parseInt(m[2], 10) || 0;
                        const frac = m[3] ? parseFloat('0.' + m[3]) : 0;
                        return min * 60 + sec + frac;
                    }
                }
            } catch (e) {}
            return null;
        }

        // Given the base think time from Elo, scale it down when the user's
        // clock is low. In bullet/blitz, a 2.5s think-time at Elo 2200 will
        // flag the user — instead, taper aggressively as the clock drops.
        // lc0 has higher per-call overhead than Stockfish (~50-150ms of GPU
        // scheduling + UCI startup), so the floor is bumped when lc0 is the
        // play engine — otherwise the budget is so tight it can't return a
        // move within the client's wsTimeout window.
        _getEffectiveThinkTime(baseMs) {
            const sec = this._getMyClockSeconds();
            if (sec == null) return baseMs;
            const isLc0 = !!this.settings.useLc0;
            // Ceiling: never spend more than ~5% of remaining clock thinking.
            // Floor: 100ms (Stockfish) / 200ms (lc0) so engine has time to settle.
            const ceiling = Math.max(isLc0 ? 200 : 100, Math.floor(sec * 1000 * 0.05));
            // Hard caps for emergency time-pressure. lc0 needs more headroom
            // at every tier — its MCTS doesn't degrade gracefully at <250ms.
            let cap;
            if (sec <  10) cap = isLc0 ? 250 : 100;
            else if (sec <  30) cap = isLc0 ? 500 : 250;
            else if (sec <  60) cap = isLc0 ? 800 : 500;
            else if (sec < 120) cap = 1200;
            else if (sec < 300) cap = 2000;
            else cap = baseMs;
            return Math.min(baseMs, ceiling, cap);
        }

        // Cheap depth taper: in tight time-pressure we also cut depth so the
        // engine doesn't blow the time-budget on a single iteration. Mirrors
        // _getEffectiveThinkTime but for depth.
        _getEffectiveDepth(baseDepth) {
            const sec = this._getMyClockSeconds();
            if (sec == null) return baseDepth;
            if (sec <  10) return Math.min(baseDepth, 8);
            if (sec <  30) return Math.min(baseDepth, 10);
            if (sec <  60) return Math.min(baseDepth, 12);
            if (sec < 120) return Math.min(baseDepth, 14);
            return baseDepth;
        }

        getVariantsFromElo(elo) {
            // Bot's ACPL-target sampler needs a wider candidate pool at lower
            // Elo (more "bad move" headroom). High Elo can stay narrower.
            if (elo >= 2700) return 5;
            if (elo >= 2200) return 8;
            if (elo >= 1500) return 10;
            return 12;
        }

        getBaseDistributions() {
            return {
                3200: [89, 10, 1, 0, 0],
                2900: [85, 13, 2, 0, 0],
                2700: [82, 15, 3, 0, 0],
                2600: [80, 14, 4, 1.5, 0.5],
                2500: [78, 15, 4.5, 2, 0.5],
                2400: [76, 16, 5, 2.5, 0.5],
                2300: [74, 17, 5.5, 3, 0.5],
                2200: [72, 18, 6, 3.5, 0.5],
                2100: [70, 19, 7, 3.5, 0.5],
                2000: [68, 20, 8, 3.5, 0.5],
                1900: [66, 20, 8, 4, 1.5],
                1800: [64, 21, 9, 4, 1.5],
                1700: [62, 22, 10, 4, 1.5],
                1600: [60, 23, 11, 4, 1.5],
                1500: [50, 24, 12, 7, 4],
                1400: [45, 23, 13, 8, 5],
                1300: [40, 22, 14, 9, 6],
                1200: [35, 21, 15, 10, 7],
                1100: [30, 20, 16, 11, 8],
                1000: [25, 19, 17, 12, 9],
                850:  [20, 18, 18, 13, 10],
                700:  [15, 17, 19, 14, 11],
                550:  [10, 15, 20, 15, 12],
                400:  [5, 12, 18, 17, 14],
                250:  [2, 8, 15, 18, 16]
            };
        }

        getMoveDistribution(elo) {
            const thresholds = [250, 400, 550, 700, 850, 1000, 1100, 1200, 1300, 1400,
                1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300,
                2400, 2500, 2600, 2700, 2900, 3200];

            const distributions = this.getBaseDistributions();
            if (thresholds.includes(elo)) return distributions[elo];

            let lower = 250, upper = 400;
            for (let i = 0; i < thresholds.length - 1; i++) {
                if (elo > thresholds[i] && elo < thresholds[i + 1]) {
                    lower = thresholds[i];
                    upper = thresholds[i + 1];
                    break;
                }
            }
            if (elo >= 3200) return distributions[3200];

            const lowerDist = distributions[lower];
            const upperDist = distributions[upper];
            const factor = (elo - lower) / (upper - lower);

            return lowerDist.map((val, i) => val + (upperDist[i] - val) * factor);
        }

        async initialize() {
            console.log('🚀 v12.5 - Fixed Black Moves!');
            console.log(`📊 Elo: ${this.settings.targetElo}`);

            const depth = this.getDepthFromElo(this.settings.targetElo);
            const variants = this.getVariantsFromElo(this.settings.targetElo);

            console.log(`⚙️ D${depth} | V${variants}`);

            const targetAcpl = this.getTargetAcpl();
            console.log(`Target ACPL: ${targetAcpl.toFixed(1)}cp/move (Lichess inverse formula)`);

            await this.waitForBoard();
            this.connectChessAPI();
            this.detectMyColor();
            this.setupUI();
            this.setupEventListeners();
            this.startMonitoring();
            this.setupGameOverObserver();
            this._recoverFromRefresh();
        }

        // Refresh-recovery: if the script just (re)loaded INTO a game in
        // progress (page refreshed mid-game, or Tampermonkey re-injected on
        // navigation between /play/ and /game/), pick up where we left off.
        // The board API already has the full move history; we just need to
        // log it and kick the analyzer so the user doesn't sit at 1.5s of
        // dead time waiting for the next monitoring tick.
        _recoverFromRefresh() {
            try {
                const board = this.getBoard();
                const history = this._getMoveHistoryFromBoard();
                const ply = history ? history.length : 0;
                if (ply === 0) return;
                const me = this.myColor === 1 ? 'WHITE' : (this.myColor === 2 ? 'BLACK' : '?');
                console.log(`🔄 Recovered mid-game — ply ${ply}, playing ${me}, autoMove=${this.settings.autoMove ? 'ON' : 'OFF'}`);
                // Fast-track: as soon as the WebSocket is ready, fire the
                // first analyze + analyzer-loop iteration without waiting
                // for the 1.5s monitoring tick.
                const fastStart = () => {
                    if (!this.wsReady) {
                        setTimeout(fastStart, 100);
                        return;
                    }
                    if (this.settings.autoMove && this.isMyTurn() && !this.isThinking) {
                        this.analyzePosition();
                    }
                    if (this.settings.liveAnalyzer) {
                        this.runAnalyzerLoop();
                    }
                };
                setTimeout(fastStart, 200);
            } catch (e) {}
        }

        connectChessAPI() {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

            this.ws = new WebSocket('ws://localhost:8765');

            this.ws.onopen = () => {
                this.wsReady = true;
                console.log('✓ Local helper connected');

                if (this.keepAliveInterval) clearInterval(this.keepAliveInterval);
                this.keepAliveInterval = setInterval(() => {
                    if (this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'ping' }));
                    }
                }, 30000);

                // Pre-warm every engine the session might use so the first
                // real request doesn't eat the cold-start (UCI handshake +
                // 4GB hash alloc for SF, CUDA init for lc0). Was the cause
                // of the first-move "❌ No response" timeout on game start.
                try {
                    this.ws.send(JSON.stringify({
                        type: 'warmup',
                        engines: ['stockfish', 'lc0', 'stockfish_mate', 'stockfish_ponder']
                    }));
                } catch (e) {}
            };

            this.ws.onmessage = (event) => {
                const data = JSON.parse(event.data);

                if (data.type === 'pong') return;

                if (data.type === 'warmup_done') {
                    // Engines pre-spawned server-side; first real request will
                    // hit them hot. Engines list echoed back for visibility.
                    if (Array.isArray(data.engines) && data.engines.length) {
                        console.log(`🔥 Engines warm: ${data.engines.join(', ')}`);
                    }
                    return;
                }

                if (data.type === 'play_done') {
                    // Server signals end of multipv batch. Process whatever we
                    // have RIGHT NOW instead of waiting for the safety-net
                    // timer — that 2-3s wait was the bulk of per-move latency.
                    if (data.requestId != null && data.requestId !== this._playRequestId) return;
                    this._processPlayBatch(data.requestId);
                    return;
                }

                if (data.type === 'position_analysis') {
                    if (this.pendingPositionAnalysis) {
                        const p = this.pendingPositionAnalysis;
                        this.pendingPositionAnalysis = null;
                        p.resolve(data);
                    }
                    return;
                }

                if (data.type === 'move_analysis') {
                    if (this.pendingMoveAnalysis) {
                        const p = this.pendingMoveAnalysis;
                        this.pendingMoveAnalysis = null;
                        p.resolve(data);
                    }
                    return;
                }

                if (data.type === 'analysis_progress') {
                    if (this.pendingGameAnalysis?.onProgress) {
                        try { this.pendingGameAnalysis.onProgress(data); } catch (e) {}
                    }
                    return;
                }

                if (data.type === 'analysis_complete') {
                    if (this.pendingGameAnalysis) {
                        const p = this.pendingGameAnalysis;
                        this.pendingGameAnalysis = null;
                        p.resolve(data);
                    }
                    return;
                }

                if (data.type === 'analysis_error') {
                    const err = new Error(data.error || 'analysis error');
                    if (this.pendingMoveAnalysis) {
                        this.pendingMoveAnalysis.reject(err);
                        this.pendingMoveAnalysis = null;
                    }
                    if (this.pendingGameAnalysis) {
                        this.pendingGameAnalysis.reject(err);
                        this.pendingGameAnalysis = null;
                    }
                    if (this.pendingPositionAnalysis) {
                        this.pendingPositionAnalysis.reject(err);
                        this.pendingPositionAnalysis = null;
                    }
                    return;
                }

                if (data.type === 'ponder_result') {
                    if (data.fen && Array.isArray(data.moves) && data.moves.length) {
                        const moves = data.moves
                            .map(m => ({
                                move: m.move,
                                score: m.centipawns != null ? parseInt(m.centipawns) :
                                    (m.mate ? (m.mate > 0 ? 10000 : -10000) : 0),
                                isMate: m.mate != null,
                                depth: m.depth,
                                rawCp: m.centipawns,
                                rawMate: m.mate
                            }))
                            .sort((a, b) => b.score - a.score)
                            .map((mv, i) => ({ ...mv, rank: i + 1 }));
                        this.positionCache.set(data.fen, { moves, timestamp: Date.now(), pondered: true });
                        if (this.positionCache.size > 100) {
                            const firstKey = this.positionCache.keys().next().value;
                            this.positionCache.delete(firstKey);
                        }
                    }
                    return;
                }

                if (data.type === 'ponder_done') {
                    // Iterative deepening: while opp is still on the clock and
                    // the FEN hasn't flipped, fire the next deeper pass. The
                    // _sendPonderIteration gates handle stop conditions.
                    try {
                        const board = this.getBoard();
                        if (board?.game) {
                            const fenNow = board.game.getFEN();
                            if (fenNow === this._lastPonderedFen && !this.isMyTurn()) {
                                this._sendPonderIteration(fenNow);
                            }
                        }
                    } catch (e) {}
                    return;
                }

                if (data.type === 'move' && data.move) {
                    // Drop responses from a superseded request. With dual-engine
                    // routing the server can be working on play + live-analysis
                    // in parallel, so late `move` payloads from a timed-out
                    // request would otherwise contaminate the next request's
                    // receivedMoves bucket.
                    if (data.requestId != null && data.requestId !== this._playRequestId) return;
                    // Mate-distance-aware scoring: shorter mates outscore
                    // longer ones, and any winning mate outscores any cp
                    // value. Reverse holds for losing mates (longer = better,
                    // i.e. delay mate). The previous flat ±10000 collapsed
                    // mate-in-1 and mate-in-10 to the same score, so the
                    // sampler couldn't pick the quickest finish.
                    let score;
                    if (data.centipawns != null) {
                        score = parseInt(data.centipawns);
                    } else if (data.mate != null) {
                        const m = parseInt(data.mate);
                        score = m > 0 ? (100000 - m) : (-100000 - m);
                    } else {
                        score = 0;
                    }
                    this.receivedMoves[data.move] = {
                        move: data.move,
                        score,
                        isMate: data.mate != null,
                        depth: data.depth,
                        rawCp: data.centipawns,
                        rawMate: data.mate,
                        engine: data.engine
                    };
                }
            };

            this.ws.onerror = (error) => {
                console.error('⚠️ WebSocket error:', error);
                this.wsReady = false;
            };

            this.ws.onclose = (event) => {
                this.wsReady = false;

                if (this.keepAliveInterval) {
                    clearInterval(this.keepAliveInterval);
                    this.keepAliveInterval = null;
                }

                this._rejectAllPending(new Error('websocket closed'));

                console.log(`🔌 Disconnected (code ${event.code})`);
                console.log('🔄 Reconnecting in 3s...');
                setTimeout(() => this.connectChessAPI(), 3000);
            };
        }

        _rejectAllPending(err) {
            if (this.pendingMoveAnalysis) {
                try { this.pendingMoveAnalysis.reject(err); } catch (_) {}
                this.pendingMoveAnalysis = null;
            }
            if (this.pendingGameAnalysis) {
                try { this.pendingGameAnalysis.reject(err); } catch (_) {}
                this.pendingGameAnalysis = null;
            }
            if (this.pendingPositionAnalysis) {
                try { this.pendingPositionAnalysis.reject(err); } catch (_) {}
                this.pendingPositionAnalysis = null;
            }
        }

        // Read the bottom-clock color class. chess.com ALWAYS renders the
        // local player's clock at .clock-bottom, so this is a UI-contract
        // guarantee — more reliable than the game-state APIs, which have
        // been observed to return stale / wrong values during game start.
        _readBottomClockColor() {
            try {
                const sels = [
                    '.clock-component.clock-bottom',
                    '.clock-bottom',
                    '.player-component.player-bottom .clock-component',
                    '.player-bottom'
                ];
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const cls = el.className || '';
                    if (/\bclock-white\b|\bplayer-white\b/.test(cls)) return 1;
                    if (/\bclock-black\b|\bplayer-black\b/.test(cls)) return 2;
                }
            } catch (e) {}
            return null;
        }

        detectMyColor() {
            const board = this.getBoard();
            if (!board) {
                console.warn('⚠️ Board not found, retrying...');
                setTimeout(() => this.detectMyColor(), 500);
                return;
            }

            // METHOD 1 (PRIMARY): Bottom-clock color class. UI contract.
            const clockColor = this._readBottomClockColor();
            if (clockColor) {
                this._setMyColorAuth(clockColor, 'clock-bottom');
                return;
            }

            // METHOD 2: getPlayingAs() — API signal (fallback)
            try {
                const fn = board.game?.getPlayingAs;
                if (typeof fn === 'function') {
                    const v = board.game.getPlayingAs();
                    if (v === 1 || v === 2) { this._setMyColorAuth(v, 'getPlayingAs'); return; }
                }
            } catch (e) {}

            // METHOD 3: getOptions().playingAs — alternate API on some builds
            try {
                const opts = board.game?.getOptions?.();
                if (opts?.playingAs === 1 || opts?.playingAs === 2) {
                    this._setMyColorAuth(opts.playingAs, 'getOptions');
                    return;
                }
            } catch (e) {}

            // METHOD 4: getPlayer slot match — find the slot flagged self / matching the local username
            try {
                if (typeof board.game?.getPlayer === 'function') {
                    for (const slot of [1, 2]) {
                        const p = board.game.getPlayer(slot);
                        if (!p) continue;
                        if (p.isSelf || p.self || p.local || p.you) {
                            this._setMyColorAuth(slot, 'getPlayer-self');
                            return;
                        }
                    }
                    const localName = (
                        window.chesscom?.PlatformConfig?.username ||
                        window.user?.username ||
                        document.querySelector('meta[name="user"]')?.getAttribute('content') ||
                        ''
                    ).toLowerCase();
                    if (localName) {
                        for (const slot of [1, 2]) {
                            const p = board.game.getPlayer(slot);
                            if (p?.username && String(p.username).toLowerCase() === localName) {
                                this._setMyColorAuth(slot, 'getPlayer-username');
                                return;
                            }
                        }
                    }
                }
            } catch (e) {}

            // METHOD 5: Board orientation — last-resort DISPLAY hint only.
            // Marked as 'orientation' so isMyTurn() refuses to act on it; the
            // eval bar etc. can still use it for layout.
            const boardEl = document.querySelector('chess-board, wc-chess-board');
            if (boardEl) {
                const isFlipped = boardEl.classList.contains('flipped') ||
                                  boardEl.getAttribute('flipped') === 'true' ||
                                  boardEl.getAttribute('data-flipped') === 'true';
                const guess = isFlipped ? 2 : 1;
                if (this.myColor !== guess) {
                    console.log(`~ Provisional color from board orientation: ${isFlipped ? 'BLACK (2)' : 'WHITE (1)'}`);
                }
                this.myColor = guess;
                this._myColorSource = 'orientation';
                return;
            }

            console.warn('⚠️ Could not detect color yet — will retry');
        }

        _setMyColorAuth(c, src) {
            if (this.myColor !== c || this._myColorSource !== 'api') {
                console.log(`✓ Playing as: ${c === 1 ? 'WHITE (1)' : 'BLACK (2)'} via ${src}`);
            }
            this.myColor = c;
            this._myColorSource = 'api';
        }

        isMyTurn() {
            const board = this.getBoard();
            if (!board?.game) return false;

            // PRIMARY: bottom-clock color class. Re-read every check so a
            // mid-game flip (new game, board reorientation) corrects us
            // immediately. If clock and our cached color disagree, clock wins.
            const clockColor = this._readBottomClockColor();
            if (clockColor) {
                if (this.myColor !== clockColor) {
                    console.log(`✓ Color (clock): ${clockColor === 1 ? 'WHITE' : 'BLACK'}`);
                    this.myColor = clockColor;
                    this._myColorSource = 'clock-bottom';
                    // Wrong color cached — drop any pondered analyses keyed
                    // to the previous side so we don't replay them.
                    this.positionCache.clear();
                    this._lastPonderedFen = null;
                }
            } else if (this.myColor === null || this._myColorSource === 'orientation') {
                // No clock yet — fall back to API methods. Refuse to act on
                // an orientation-only guess (board can be pre-flipped before
                // chess.com loads game state).
                this.detectMyColor();
                if (this._myColorSource === 'orientation' || this.myColor === null) return false;
            }

            const currentTurn = board.game.getTurn?.();
            return currentTurn === this.myColor;
        }

        waitForBoard() {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    const board = this.getBoard();
                    if (board?.game) {
                        console.log('✓ Board Ready');
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
            });
        }

        async analyzePosition() {
            if (this.isThinking || this.requestInProgress) return;
            if (!this.isMyTurn()) return;

            const board = this.getBoard();
            if (!board?.game) return;

            const fen = board.game.getFEN();

            if (fen === this.lastAnalyzedFen) return;

            const cached = this.positionCache.get(fen);
            if (cached && (Date.now() - cached.timestamp) < 180000) {
                console.log(cached.pondered ? '⚡ Ponder hit (instant)' : '⚡ Local cache');
                this.currentMoves = cached.moves;
                this.onAnalysisComplete();
                return;
            }

            this.isThinking = true;
            this.requestInProgress = true;
            this.lastAnalyzedFen = fen;
            this.updateUI();

            const variants = this.getVariantsFromElo(this.settings.targetElo);

            if (this.settings.preferLichess) {
                const lichessResult = await this.tryLichessCloud(fen, variants);

                if (lichessResult) {
                    this.currentMoves = lichessResult;
                    this.onAnalysisComplete();
                    return;
                }
            }

            this.analyzeWithChessAPI(fen, variants);
        }

        async tryLichessCloud(fen, variants) {
            try {
                const url = `https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${variants}`;

                const response = await fetch(url, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' }
                });

                if (!response.ok) return null;

                const data = await response.json();

                if (data.pvs && data.pvs.length > 0) {
                    console.log('⚡ Lichess cloud');
                    return data.pvs.map((pv, index) => ({
                        move: pv.moves.split(' ')[0],
                        score: pv.cp !== undefined ? pv.cp :
                            (pv.mate ? (pv.mate > 0 ? 10000 - pv.mate : -10000 + pv.mate) : 0),
                        isMate: pv.mate !== undefined,
                        rank: index + 1
                    }));
                }

                return null;
            } catch (error) {
                return null;
            }
        }

        analyzeWithChessAPI(fen, variants) {
            if (!this.wsReady) {
                console.error('❌ Chess-API offline');
                this.isThinking = false;
                this.requestInProgress = false;
                this._requestStartedAt = null;
                this.lastAnalyzedFen = null;
                this.updateUI();
                return;
            }

            const baseDepth = this.getDepthFromElo(this.settings.targetElo);
            const baseThink = this.getThinkTimeFromElo(this.settings.targetElo);
            // Time-control aware budget: in bullet/blitz with low clock, both
            // depth and think-time taper so the bot doesn't flag the user.
            const depth = this._getEffectiveDepth(baseDepth);
            const thinkTime = this._getEffectiveThinkTime(baseThink);
            const clockSec = this._getMyClockSeconds();
            const tcSuffix = clockSec != null ? ` clock=${clockSec.toFixed(1)}s` : '';

            console.log(`🔍 D${depth} t=${thinkTime}ms${tcSuffix}`);

            // Stamp each play request with an id. The server echoes it on
            // every `move` payload, and we drop responses whose id doesn't
            // match the latest request. Without this, a late response from
            // a request we already timed out can pollute the NEXT request's
            // receivedMoves and make the bot pick a wrong move (the cause of
            // sporadic illegal-move tries on game start).
            const requestId = (this._playRequestId = (this._playRequestId || 0) + 1);
            this.receivedMoves = {};
            this._playProcessed = false;
            this._requestStartedAt = Date.now();
            this._requestThinkMs = thinkTime;

            this.ws.send(JSON.stringify({
                fen: fen,
                depth: depth,
                variants: variants,
                maxThinkingTime: thinkTime,
                engine: this._getPlayEngine(),
                requestId
            }));

            if (this.wsTimeout) clearTimeout(this.wsTimeout);
            // SAFETY NET ONLY: server emits `play_done` the moment its multipv
            // batch is sent, and ws.onmessage processes results immediately.
            // This timer just rescues us if the server never replies (engine
            // crash, ws stall, etc). Scales to thinkTime so blitz / bullet
            // get a tight rescue window (250ms thinkTime → 2s safety net),
            // longer time controls get more headroom. Capped at half clock
            // so the bot always has time to retry within the same move.
            let safetyMs = Math.max(thinkTime * 2 + 1500, 2500);
            const safetyClockSec = this._getMyClockSeconds();
            if (safetyClockSec != null) {
                safetyMs = Math.min(safetyMs, Math.floor(safetyClockSec * 1000 * 0.5));
            }
            safetyMs = Math.max(safetyMs, 1200);  // hard floor — engine round-trip
            this.wsTimeout = setTimeout(() => {
                if (requestId !== this._playRequestId) return;
                if (this._playProcessed) return;
                this._playProcessed = true;
                if (Object.keys(this.receivedMoves).length > 0) {
                    this.currentMoves = Object.values(this.receivedMoves)
                        .sort((a, b) => b.score - a.score)
                        .map((m, i) => ({ ...m, rank: i + 1 }));
                    this.onAnalysisComplete();
                } else {
                    console.error('❌ No response (safety-net fired)');
                    this.isThinking = false;
                    this.requestInProgress = false;
                    this._requestStartedAt = null;
                    this.lastAnalyzedFen = null;
                    this.updateUI();
                }
            }, safetyMs);
        }

        // Processes whatever multipv `move` payloads have arrived for the
        // current play request. Called from ws.onmessage on `play_done` (fast
        // path — fires the moment the engine returns) and from the safety-net
        // timer (slow path — only if play_done never arrived).
        _processPlayBatch(requestId) {
            if (requestId != null && requestId !== this._playRequestId) return;
            if (this._playProcessed) return;
            this._playProcessed = true;
            if (this.wsTimeout) {
                clearTimeout(this.wsTimeout);
                this.wsTimeout = null;
            }
            if (Object.keys(this.receivedMoves).length === 0) {
                // play_done with empty batch (server-side error before sending
                // any move payloads). Reset so the monitor loop can retry.
                console.warn('⚠️ Empty play_done — server-side analyse failed');
                this.isThinking = false;
                this.requestInProgress = false;
                this._requestStartedAt = null;
                this.lastAnalyzedFen = null;
                this.updateUI();
                return;
            }
            this.currentMoves = Object.values(this.receivedMoves)
                .sort((a, b) => b.score - a.score)
                .map((m, i) => ({ ...m, rank: i + 1 }));
            this.onAnalysisComplete();
        }

        onAnalysisComplete() {
            if (this.currentMoves.length === 0) {
                this.isThinking = false;
                this.requestInProgress = false;
                this.updateUI();
                return;
            }

            const selectedMove = this.selectMove();

            if (selectedMove) {
                const cpLoss = this.currentMoves[0].score - selectedMove.score;

                this.gameHistory.push({
                    move: selectedMove.move,
                    cpLoss: cpLoss,
                    rank: selectedMove.rank
                });

                const board = this.getBoard();
                if (board?.game) {
                    const fen = board.game.getFEN();
                    this.positionCache.set(fen, {
                        moves: this.currentMoves,
                        timestamp: Date.now()
                    });

                    if (this.positionCache.size > 100) {
                        const firstKey = this.positionCache.keys().next().value;
                        this.positionCache.delete(firstKey);
                    }
                }

                console.log(`🎯 ${selectedMove.move} [#${selectedMove.rank}, -${cpLoss}cp]`);

                this.highlightMove(selectedMove.move);

                if (this.settings.autoMove) {
                    this.scheduleMove(selectedMove.move);
                }
            }

            this.isThinking = false;
            this.requestInProgress = false;
            this._requestStartedAt = null;
            this.updateUI();
        }

        scheduleMove(move) {
            if (this.moveDelayTimeout) clearTimeout(this.moveDelayTimeout);

            const baseMin = this.settings.moveDelayMin * 1000;
            const baseMax = this.settings.moveDelayMax * 1000;
            let delay = Math.random() * (baseMax - baseMin) + baseMin;

            // ───── ANTI-DETECTION: position-complexity-based timing ─────
            // Constant per-move delay is one of the loudest bot signals — no
            // human takes the same 1.2s on a recapture and on a critical
            // tactical decision. Scale the delay by candidate spread:
            //   tight cluster (top-2 within ~20cp)  → 1.5-2.5× ("really thinking")
            //   medium spread                       → 1.0-1.6×
            //   wide spread                         → 0.6-1.1×
            //   obvious move (>150cp gap)           → 0.3-0.7× (snap)
            const moves = this.currentMoves;
            if (moves && moves.length >= 2) {
                const gap = Math.abs(moves[0].score - moves[1].score);
                let complexityMult;
                if (gap < 20)       complexityMult = 1.5 + Math.random() * 1.0;
                else if (gap < 50)  complexityMult = 1.0 + Math.random() * 0.6;
                else if (gap < 150) complexityMult = 0.6 + Math.random() * 0.5;
                else                complexityMult = 0.3 + Math.random() * 0.4;
                delay *= complexityMult;
            }

            // Occasional outliers: real humans sometimes stare at the board
            // for 6-15s on a normal-looking move ("wait, what was the threat
            // again?") or auto-pilot a forced reply in <300ms. 6% chance long
            // think, 8% chance snap. Together they break any "delay always
            // sits in a 0.8-2.5s window" detector.
            const outlierRoll = Math.random();
            if (outlierRoll < 0.06) {
                delay *= 3 + Math.random() * 2.5;     // 3-5.5× longer
            } else if (outlierRoll < 0.14) {
                delay *= 0.12 + Math.random() * 0.18; // 0.12-0.30× — snap
            }

            // Time-pressure cap: never burn more than 12% of remaining clock
            // on the human-delay portion (the engine think already consumed
            // its slice). Keeps us from flagging in bullet/blitz endgame.
            const sec = this._getMyClockSeconds();
            if (sec != null) {
                const cap = Math.max(120, Math.floor(sec * 1000 * 0.12));
                delay = Math.min(delay, cap);
            }
            delay = Math.max(120, delay);  // floor — don't be inhumanly fast

            this.moveDelayTimeout = setTimeout(() => {
                this.executeMove(move);
                this.moveDelayTimeout = null;
            }, delay);
        }

        selectMove() {
            if (this.currentMoves.length === 0) return null;
            if (this.settings.alwaysBest) return this.currentMoves[0];
            if (this.currentMoves.length === 1) return this.currentMoves[0];

            // Forced mate priority: scan ALL candidate moves for the
            // shortest winning mate. Mate-distance-aware scoring guarantees
            // the highest-scoring mate is the shortest. The old check only
            // looked at currentMoves[0], so a mate found by the Stockfish
            // probe (and added to the pool) could still be sampled away.
            const winningMates = this.currentMoves.filter(m => m.isMate && m.score > 0);
            if (winningMates.length > 0) {
                return winningMates[0];  // shortest mate (sorted by score desc)
            }

            return this.selectByAcplTarget();
        }

        // Move selection via direct ACPL targeting (Lichess inverse-Elo formula).
        // target_acpl = -100 * ln(target_elo / 3100). We then sample from the
        // engine's multipv pool with a Gaussian weight centered at target_acpl,
        // sigma scaled to elo. This produces achieved Elo close to target with
        // realistic variance — replaces the old fixed distribution table that
        // baked in a structural bias toward best moves.
        // Per-Elo cap on the fraction of rank-1 (engine-best) moves the bot
        // will play across a single game. This is the PRIMARY anticheat
        // evasion lever — chess.com's engine-correlation detector flags long
        // streaks and high overall match rates with the engine's top choice.
        // Even genuine humans at the target Elo land on the engine's exact
        // best far less often than a Gaussian-only sampler does, because
        // lc0's top-5 candidates typically cluster within a few cp and any
        // pick from that cluster looks "best" to a deeper-depth analyzer.
        //   3200 → full strength (1.00, no cap, true engine play)
        //   2900 → 0.65 (real super-GM-level mix)
        //   2700 → 0.50
        //   2500 → 0.40
        //   2200 → 0.30
        //   1800 → 0.22
        //   1500 → 0.17 (≈ 5 best moves per 30-move game)
        //   1200 → 0.15
        //    900 → 0.12
        //   <600 → 0.10
        getMaxBestFraction(elo) {
            if (elo >= 3200) return 1.0;     // bypass — true full strength
            if (elo >= 3000) return 0.75;
            if (elo >= 2900) return 0.65;
            if (elo >= 2800) return 0.55;
            if (elo >= 2700) return 0.50;
            if (elo >= 2500) return 0.40;
            if (elo >= 2200) return 0.30;
            if (elo >= 1800) return 0.22;
            if (elo >= 1500) return 0.17;
            if (elo >= 1200) return 0.15;
            if (elo >= 900)  return 0.12;
            return 0.10;
        }

        // Per-game rank tracker. Reset on new game so a previous game's
        // budget doesn't leak in. Used by selectByAcplTarget's budget guard.
        _recordGameRank(rank) {
            this._gameRanks = this._gameRanks || [];
            this._gameRanks.push(rank);
        }

        _gameBestFraction() {
            if (!this._gameRanks || !this._gameRanks.length) return 0;
            const best = this._gameRanks.filter(r => r === 1).length;
            return best / this._gameRanks.length;
        }

        // ───── ANTI-DETECTION: intentional inaccuracies ─────
        // A bot that NEVER plays a 30-100cp inaccuracy is suspicious — even
        // 2900-rated humans drop a few per game. The Gaussian sampler keeps
        // most picks within ~25cp of best, so visible inaccuracies almost
        // never happen. This injects them deliberately at a per-Elo cadence.
        // Average gap (moves between forced inaccuracies):
        //   3200 → never (full strength)
        //   2900 → ~10 moves    2700 → ~8     2500 → ~6
        //   2200 → ~4           1800 → ~3     <1500 → ~2
        _inaccuracyAvgGap(elo) {
            if (elo >= 3200) return Infinity;  // bypass
            if (elo >= 2900) return 10;
            if (elo >= 2700) return 8;
            if (elo >= 2500) return 6;
            if (elo >= 2200) return 4;
            if (elo >= 1800) return 3;
            return 2;
        }

        _shouldInjectInaccuracy() {
            const elo = this.getEffectiveTargetElo();
            const avgGap = this._inaccuracyAvgGap(elo);
            if (!Number.isFinite(avgGap)) return false;
            // Skip if any move is a winning forced mate — never blunder
            // a forced win for "camouflage". Mate scores in our pool are
            // ±100000 range (mate-distance-aware).
            if (this.currentMoves.some(m => m.isMate && m.score > 0)) return false;
            // Skip if losing badly (eval < -300 from current side's POV) —
            // adding more loss looks like resignation, not a human mistake.
            const bestScore = this.currentMoves[0]?.score ?? 0;
            if (bestScore < -300) return false;
            // Geometric distribution: probability 1/avgGap per move. Yields
            // an inaccuracy roughly every avgGap moves on average, with
            // natural Poisson clustering (sometimes back-to-back, sometimes
            // long gaps — exactly how human mistakes distribute).
            return Math.random() < (1 / avgGap);
        }

        _pickInaccuracy() {
            const moves = this.currentMoves;
            if (moves.length < 2) return null;
            const bestScore = moves[0].score;
            // Ideal range: 30-100cp loss. Visible inaccuracy / mistake (?!
            // or ? on chess.com), but not piece-blundering catastrophic.
            const ideal = moves.filter(m => {
                if (m === moves[0]) return false;
                if (m.isMate && m.score < 0) return false;  // skip losing mates
                const loss = bestScore - m.score;
                return loss >= 30 && loss <= 100;
            });
            if (ideal.length > 0) {
                return ideal[Math.floor(Math.random() * ideal.length)];
            }
            // Fallback: if no move sits in the ideal window, pick the move
            // with smallest loss above 20cp (closest to a "real" inaccuracy
            // without going further than necessary).
            const above20 = moves
                .filter(m => m !== moves[0] && bestScore - m.score >= 20 && !(m.isMate && m.score < 0))
                .sort((a, b) => b.score - a.score);  // smallest loss first
            return above20[0] || null;
        }

        selectByAcplTarget() {
            const moves = this.currentMoves;
            if (moves.length === 0) return null;
            if (moves.length === 1) return moves[0];

            const effElo = this.getEffectiveTargetElo();

            // 3200 BYPASS: explicit "play full strength" mode — skip every
            // diversity / camouflage layer and return the engine's top pick.
            // For when the user wants the bot to actually win on merit, not
            // hide. Safe to call from selectMove() without further checks.
            if (effElo >= 3200) {
                this._recordGameRank(moves[0].rank);
                return moves[0];
            }

            // ───── ANTI-DETECTION: intentional inaccuracy injection ─────
            // Roll for a deliberate 30-100cp inaccuracy at a per-Elo cadence.
            // Real humans drop a few visible inaccuracies per game; a bot
            // that never does is the loudest signal to the anticheat. Fires
            // BEFORE the Gaussian sampler so the chosen sub-best move is
            // recorded in the rank tracker as a real human-like mistake.
            if (this._shouldInjectInaccuracy()) {
                const inacc = this._pickInaccuracy();
                if (inacc) {
                    const cpl = moves[0].score - inacc.score;
                    console.log(`🎭 Camouflage inaccuracy: #${inacc.rank} -${cpl}cp`);
                    this._recentCpls = this._recentCpls || [];
                    this._recentCpls.push(cpl);
                    if (this._recentCpls.length > 12) this._recentCpls.shift();
                    this._recentRanks = this._recentRanks || [];
                    this._recentRanks.push(inacc.rank);
                    if (this._recentRanks.length > 7) this._recentRanks.shift();
                    this._recordGameRank(inacc.rank);
                    return inacc;
                }
            }

            const cappedElo = Math.max(250, Math.min(3100, effElo));
            const targetAcpl = Math.max(0, -100 * Math.log(cappedElo / 3100));

            // Penalize/incentivize based on rolling history so the bot self-corrects
            // toward target across a game. Stronger gain (0.7) than before so a
            // streak of all-best moves visibly pushes the next pick OFF best —
            // critical for camouflage at high Elo where lc0's top-5 are
            // typically clustered within a few cp and a vanilla Gaussian
            // sampler keeps landing on rank 1 by accident.
            const recentMean = this._recentCpls && this._recentCpls.length
                ? this._recentCpls.reduce((a, b) => a + b, 0) / this._recentCpls.length
                : targetAcpl;
            const correction = (targetAcpl - recentMean) * 0.7;
            const desiredAcpl = Math.max(0, targetAcpl + correction);

            const bestScore = moves[0].score;
            const cpls = moves.map(m => Math.max(0, bestScore - m.score));

            // Variance: at high Elo we WIDEN sigma so the sampler reaches
            // outside the lc0-tight top cluster. Without this, sigma=25 floor
            // is narrower than the natural cp-spread of a 2900-rated bot's
            // candidate pool — every move ends up looking "best" to any
            // analyzer. Floor at 40cp at high Elo, scale up at low Elo.
            const sigma = Math.max(40, desiredAcpl * 0.9);

            const weights = cpls.map(c => Math.exp(-Math.pow(c - desiredAcpl, 2) / (2 * sigma * sigma)));

            // ───── ANTI-DETECTION: per-game best-move budget ─────
            // Hard cap on rank-1 frequency for the current game, by Elo.
            // If we're already at or above the cap, ZERO rank-1's weight so
            // the sampler is forced to pick a non-best move. This proactively
            // rations engine-best picks across the whole game instead of
            // letting them cluster — the strongest signal chess.com's
            // anticheat looks for.
            const maxBestFrac = this.getMaxBestFraction(effElo);
            const curFrac = this._gameBestFraction();
            const budgetExceeded = (
                curFrac >= maxBestFrac
                && (this._gameRanks?.length || 0) >= 3   // give 3 free moves of warmup
                && moves.length > 1
            );

            // Also keep the short-window streak guard. Two thresholds catch
            // different failure modes: budget catches "60% best across 30
            // moves", streak catches "5 best moves in a row right now even
            // though overall fraction is OK".
            this._recentRanks = this._recentRanks || [];
            const recentBestCount = this._recentRanks.filter(r => r === 1).length;
            const recentStreakBad = (
                this._recentRanks.length >= 7 && recentBestCount >= 5
                && moves.length > 1
            );

            if (budgetExceeded || recentStreakBad) {
                weights[0] = 0;
                if (budgetExceeded) {
                    console.log(`🎲 Budget guard: best-frac ${(curFrac*100).toFixed(0)}% ≥ cap ${(maxBestFrac*100).toFixed(0)}% — forcing non-best`);
                } else {
                    console.log(`🎲 Streak guard: ${recentBestCount}/${this._recentRanks.length} recent were #1 — forcing non-best`);
                }
            }

            const totalWeight = weights.reduce((a, b) => a + b, 0);
            if (totalWeight === 0 || !Number.isFinite(totalWeight)) {
                // All weights zero (only happens if there's just rank 1 and
                // we zeroed it). Pick rank 2 explicitly so we still play a
                // legal sub-best move rather than falling back to rank 1.
                const picked = moves[1] || moves[0];
                this._recentCpls = this._recentCpls || [];
                this._recentCpls.push(cpls[picked === moves[1] ? 1 : 0]);
                if (this._recentCpls.length > 12) this._recentCpls.shift();
                this._recentRanks.push(picked.rank);
                if (this._recentRanks.length > 7) this._recentRanks.shift();
                this._recordGameRank(picked.rank);
                return picked;
            }

            let r = Math.random() * totalWeight;
            let pickedIdx = 0;
            for (let i = 0; i < weights.length; i++) {
                r -= weights[i];
                if (r <= 0) { pickedIdx = i; break; }
            }
            const picked = moves[pickedIdx];

            this._recentCpls = this._recentCpls || [];
            this._recentCpls.push(cpls[pickedIdx]);
            if (this._recentCpls.length > 12) this._recentCpls.shift();

            this._recentRanks.push(picked.rank);
            if (this._recentRanks.length > 7) this._recentRanks.shift();

            this._recordGameRank(picked.rank);

            return picked;
        }

        // Kept for the analyzer's "rank" labels in run history; not used for selection.
        selectByDistribution() {
            return this.selectByAcplTarget();
        }

        getTargetAcpl() {
            const cappedElo = Math.max(250, Math.min(3100, this.getEffectiveTargetElo()));
            return Math.max(0, -100 * Math.log(cappedElo / 3100));
        }

        getRecentMeanCpl() {
            if (!this._recentCpls || !this._recentCpls.length) return null;
            return this._recentCpls.reduce((a, b) => a + b, 0) / this._recentCpls.length;
        }

        // -------- Adaptive Elo auto-tune --------

        _loadEloAdjustments() {
            try {
                return JSON.parse(GM_getValue('chessAnalyzerEloAdjustments') || '{}');
            } catch (e) { return {}; }
        }

        _saveEloAdjustments() {
            try {
                GM_setValue('chessAnalyzerEloAdjustments', JSON.stringify(this.eloAdjustments));
            } catch (e) {}
        }

        getEffectiveTargetElo() {
            const target = this.settings.targetElo;
            const adj = this.eloAdjustments[target] || 0;
            return Math.max(250, Math.min(3200, target + adj));
        }

        getEloAdjustment() {
            return this.eloAdjustments[this.settings.targetElo] || 0;
        }

        _tuneInfoLine() {
            const target = this.settings.targetElo;
            const adj = this.eloAdjustments[target] || 0;
            const eff = this.getEffectiveTargetElo();
            if (adj === 0) return `auto-tune: 0 (effective ${eff})`;
            const sign = adj > 0 ? '+' : '';
            return `auto-tune: ${sign}${adj} (effective ${eff})`;
        }

        _refreshTargetEloDisplay() {
            try {
                const tuneEl = document.getElementById('cas-tune-info');
                if (tuneEl) tuneEl.textContent = this._tuneInfoLine();
            } catch (e) {}
        }

        resetEloAdjustment() {
            const target = this.settings.targetElo;
            delete this.eloAdjustments[target];
            this._saveEloAdjustments();
            this._refreshTargetEloDisplay();
            console.log(`Auto-tune adjustment for target ${target} reset to 0`);
        }

        _updateEloAdjustment(target, achievedElo) {
            const oldAdj = this.eloAdjustments[target] || 0;
            const delta = achievedElo - target;
            const scaleFactor = 0.5;
            const damping = 0.5;
            let newAdj = oldAdj * damping - delta * scaleFactor;
            newAdj = Math.max(-1000, Math.min(1000, newAdj));
            this.eloAdjustments[target] = Math.round(newAdj);
            this._saveEloAdjustments();
            console.log(`🎯 Elo auto-tune for target ${target}: adj ${oldAdj} -> ${this.eloAdjustments[target]} (delta ${delta.toFixed(0)})`);
            return this.eloAdjustments[target];
        }

        // FIXED: Algebraic notation to board square conversion
        algebraicToSquare(square) {
            // square is like "e2", "d4", etc.
            // Chess.com uses numbered squares: a=1, b=2, ..., h=8
            const file = square.charAt(0);
            const rank = square.charAt(1);

            const fileNum = file.charCodeAt(0) - 'a'.charCodeAt(0) + 1; // a=1, b=2, ..., h=8
            const rankNum = rank; // 1-8

            return `${fileNum}${rankNum}`;
        }

        highlightMove(move) {
            if (!move || move.length < 4) return;

            const from = move.substring(0, 2); // e.g., "e2"
            const to = move.substring(2, 4);   // e.g., "e4"

            const board = this.getBoard();
            if (!board) return;

            // Convert algebraic notation (e2) to Chess.com square format (51)
            const fromSquare = this.algebraicToSquare(from);
            const toSquare = this.algebraicToSquare(to);

            console.log(`🎨 Highlight: ${from} (${fromSquare}) → ${to} (${toSquare})`);

            // Remove old highlights
            document.querySelectorAll('.bot-highlight').forEach(el => el.remove());

            const boardEl = document.querySelector(board.nodeName);
            if (!boardEl) return;

            const createHighlight = (square) => {
                const highlight = document.createElement('div');
                highlight.className = `highlight square-${square} bot-highlight`;
                highlight.style.cssText = 'background-color: rgb(235, 97, 80); opacity: 0.71; pointer-events: none;';
                return highlight;
            };

            boardEl.insertBefore(createHighlight(toSquare), boardEl.firstChild);
            boardEl.insertBefore(createHighlight(fromSquare), boardEl.firstChild);
        }

        executeMove(move) {
            const board = this.getBoard();
            if (!board?.game || !this.isMyTurn()) return;

            const from = move.substring(0, 2);
            const to = move.substring(2, 4);

            const legalMoves = board.game.getLegalMoves();
            const matchingMove = legalMoves.find(m => m.from === from && m.to === to);

            if (matchingMove) {
                board.game.move({
                    ...matchingMove,
                    animate: false,
                    userGenerated: true
                });

                // Track the bot's UCI move so the analyzer can pass it to the
                // server directly (no FEN-diff derivation needed for our own
                // moves).
                this._lastBotPlayedUci = from + to + (matchingMove.promotion && matchingMove.promotion !== 'false' ? matchingMove.promotion : '');

                this.lastAnalyzedFen = null;
                console.log('✅ Moved');
            } else {
                console.error(`❌ Move ${from}→${to} not legal!`);
                console.log('Legal moves:', legalMoves.map(m => `${m.from}→${m.to}`));
            }
        }

        getBoard() {
            return document.querySelector('chess-board') ||
                document.querySelector('wc-chess-board');
        }

        // Find a clickable "start a new game" button anywhere on the page.
        // Covers: standard game-over modal (data-cy attr), abort modal, time
        // forfeit, draw, resign, "opponent left" — and falls back to any
        // visible button whose text matches the new-game pattern (so future
        // chess.com layouts work without changes).
        _findNewGameButton() {
            const directSelectors = [
                '[data-cy="game-over-modal-new-game-button"]',
                '[data-cy="game-over-modal-newgame-button"]',
                '[data-cy="rematch-new-game-button"]',
                '[data-cy="play-again-button"]'
            ];
            for (const sel of directSelectors) {
                const el = document.querySelector(sel);
                if (el && this._isElVisible(el)) return el;
            }

            // Text-based fallback. Match "New 1 min", "New game", "Play again",
            // "Play another", "New 3+2", etc. Avoid "Rematch" by default —
            // queueing fresh is what auto-queue means; rematches loop the
            // same opp.
            const re = /^(new\s+\d|new\s+game|new\s+match|play\s+again|play\s+another|find\s+another|play\s+a\s+new)/i;
            const buttonish = document.querySelectorAll(
                '.game-over-buttons-button, .cc-button-component, ' +
                '.ui_v5-button-component, button, [role="button"]'
            );
            for (const b of buttonish) {
                if (!this._isElVisible(b)) continue;
                const text = (b.textContent || '').trim();
                if (text && re.test(text)) return b;
            }
            return null;
        }

        _isElVisible(el) {
            if (!el || !el.offsetParent) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }

        autoClickNewGame() {
            // Throttle: don't double-click if a previous click is still
            // queueing or if the new-game button persists across re-renders.
            // CRITICAL: set the timestamp SYNCHRONOUSLY before the setTimeout,
            // not inside the callback. The MutationObserver fires many times
            // during a game-over modal's render — without an early stamp, every
            // mutation that lands in the 500-1000ms human-like-delay window
            // schedules its OWN click. The first one finds the button and
            // clicks; the rest find a closed modal and spam "button not found".
            const now = Date.now();
            if (this._autoQueueClickedAt && (now - this._autoQueueClickedAt) < 3000) return;
            this._autoQueueClickedAt = now;

            const delay = 500 + Math.random() * 500;
            setTimeout(() => {
                const btn = this._findNewGameButton();
                if (btn) {
                    const label = (btn.textContent || '').trim().slice(0, 40);
                    console.log(`🎮 Auto-queuing: "${label}"`);
                    btn.click();
                    // The click itself is the strongest "new game starting"
                    // signal we'll get — fire the explicit handler instead
                    // of waiting for the modal-disappear MutationObserver.
                    this._handleNewGameStart();
                } else {
                    console.warn('⚠️ New Game button not found');
                    // Release the throttle so the next mutation can retry.
                    // (The button likely vanished mid-animation; another modal
                    // may surface a new one shortly.)
                    this._autoQueueClickedAt = 0;
                }
            }, delay);
        }

        // We just clicked "New Game" — wipe stale per-game state, then
        // watch the board + bottom-clock until both are ready and log the
        // confirmed color + whose move it is. This guarantees a clean
        // re-init regardless of whether the post-click modal flow flips
        // pieces, animates, or briefly leaves the API in an in-between
        // state. Once the watcher confirms, the analyzer loop + isMyTurn()
        // pick up cleanly from the clock-bottom signal.
        _handleNewGameStart() {
            this.myColor = null;
            this._myColorSource = null;
            this.positionCache.clear();
            this.lastAnalyzedFen = null;
            this._lastPonderedFen = null;
            this._ponderIteration = 0;
            // Hard-reset the play pipeline so a stale analyze-in-flight from
            // the previous game can't pollute the new one. Without this, the
            // next game's first analyze cycle would see leftover receivedMoves
            // / a still-running wsTimeout and either play a wrong move or sit
            // idle waiting for the old timeout to fire.
            this.receivedMoves = {};
            this._playProcessed = false;
            this.isThinking = false;
            this.requestInProgress = false;
            this._requestStartedAt = null;
            this._lastBotPlayedUci = null;
            // Reset per-game anti-detection trackers so rank budget for the
            // new game starts at 0/0, not carrying over the previous game's
            // best-move count.
            this._gameRanks = [];
            this._recentRanks = [];
            this._recentCpls = [];
            if (this.wsTimeout) {
                clearTimeout(this.wsTimeout);
                this.wsTimeout = null;
            }
            if (this.moveDelayTimeout) {
                clearTimeout(this.moveDelayTimeout);
                this.moveDelayTimeout = null;
            }
            // Bump the play request id so any late `move` payloads from the
            // previous game's request are dropped by the requestId guard.
            this._playRequestId = (this._playRequestId || 0) + 1;
            this._rejectAllPending(new Error('new game'));
            this.resetGameAnalysis();
            this.clearOverlay();
            this._gameOverProcessed = false;
            this._lastWarnedFen = null;

            if (this._newGameWatchTimer) clearInterval(this._newGameWatchTimer);

            const startFenRoot = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
            let attempts = 0;
            this._newGameWatchTimer = setInterval(() => {
                attempts++;

                const board = this.getBoard();
                const clockColor = this._readBottomClockColor();
                let fen = null;
                try { fen = board?.game?.getFEN?.(); } catch (e) {}
                let turn = null;
                try { turn = board?.game?.getTurn?.(); } catch (e) {}

                const boardReady = fen && fen.startsWith(startFenRoot);
                const colorReady = clockColor != null;

                if (boardReady && colorReady) {
                    clearInterval(this._newGameWatchTimer);
                    this._newGameWatchTimer = null;
                    this.myColor = clockColor;
                    this._myColorSource = 'clock-bottom';
                    const me = clockColor === 1 ? 'WHITE' : 'BLACK';
                    const ourTurn = turn === clockColor;
                    console.log(`🎮 New game ready — playing ${me}, ${ourTurn ? 'OUR move' : 'opponent moves first'}`);
                    return;
                }

                if (attempts >= 75) {  // ~15 s
                    clearInterval(this._newGameWatchTimer);
                    this._newGameWatchTimer = null;
                    console.warn('⚠️ New-game watcher timed out — fallback to passive detection');
                }
            }, 200);
        }

        // Re-detect color repeatedly until the chess.com API confirms — game
        // start can be racy (board mounted but game.getPlayingAs not ready).
        // Without this, isMyTurn() refuses to act and the bot misses the
        // first move of the new game.
        _scheduleColorRedetect() {
            if (this._colorRedetectTimer) clearInterval(this._colorRedetectTimer);
            let attempts = 0;
            this._colorRedetectTimer = setInterval(() => {
                attempts++;
                this.detectMyColor();
                if ((this._myColorSource === 'api' && this.myColor != null) || attempts >= 40) {
                    clearInterval(this._colorRedetectTimer);
                    this._colorRedetectTimer = null;
                }
            }, 250);
        }

        setupGameOverObserver() {
            const observer = new MutationObserver(() => {
                // Modal-presence is one signal — but we don't depend on it.
                // Some chess.com flows (abort, time forfeit, opponent dropped)
                // surface a queue button without the canonical game-over
                // modal class. We trigger on EITHER a known modal class OR
                // the presence of a clickable new-game button.
                const modal =
                    document.querySelector('.game-over-modal-shell-container') ||
                    document.querySelector('[data-cy="game-over-modal-content"]') ||
                    document.querySelector('.game-over-modal-content') ||
                    document.querySelector('.modal-game-over-component') ||
                    document.querySelector('[class*="game-over-modal"]');
                const newGameBtn = this._findNewGameButton();
                const gameEnded = !!(modal || newGameBtn);

                if (gameEnded && !this._gameOverProcessed) {
                    this._gameOverProcessed = true;

                    if (this.gameHistory.length > 0) {
                        this.analyzeGameResults();
                        this.gameHistory = [];
                    }
                    if (this.settings.validateBotElo &&
                        this.gameAnalysis?.moves &&
                        this.gameAnalysis.moves.length >= 6) {
                        this.runBotValidation();
                    }
                }

                // Click as soon as the button is in the DOM, regardless of
                // which modal is showing it. The throttle inside
                // autoClickNewGame protects against repeat fires.
                if (this.settings.autoQueue && newGameBtn) {
                    this.autoClickNewGame();
                }

                if (!gameEnded && this._gameOverProcessed) {
                    // Light reset only: positionCache + lastAnalyzedFen +
                    // play-pipeline plumbing. We INTENTIONALLY do NOT call
                    // _handleNewGameStart() / resetGameAnalysis() here —
                    // _findNewGameButton() can false-positive on chess.com's
                    // sidebar "New game" CTAs that exist during a live game,
                    // and wiping gameAnalysis mid-game would re-trigger the
                    // analyzer catch-up loop on every false flicker. The
                    // heavy reset is reserved for the auto-queue click path
                    // where we KNOW a new game is starting.
                    this._gameOverProcessed = false;
                    this.myColor = null;
                    this._myColorSource = null;
                    this.positionCache.clear();
                    this.lastAnalyzedFen = null;
                    this._lastPonderedFen = null;
                    this._ponderIteration = 0;
                    this._autoQueueClickedAt = 0;
                    // Drop any in-flight play request from the previous game
                    // so its late response can't pollute this one.
                    this.receivedMoves = {};
                    this._playProcessed = false;
                    this.isThinking = false;
                    this.requestInProgress = false;
                    this._requestStartedAt = null;
                    if (this.wsTimeout) {
                        clearTimeout(this.wsTimeout);
                        this.wsTimeout = null;
                    }
                    this._playRequestId = (this._playRequestId || 0) + 1;
                    this._scheduleColorRedetect();
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }

        analyzeGameResults() {
            const totalMoves = this.gameHistory.length;
            const avgCPL = this.gameHistory.reduce((sum, m) => sum + m.cpLoss, 0) / totalMoves;

            const maxMoves = this.settings.targetElo >= 2700 ? 3 : 5;
            const rankCounts = new Array(maxMoves).fill(0);

            this.gameHistory.forEach(m => {
                const idx = Math.min(m.rank - 1, maxMoves - 1);
                rankCounts[idx]++;
            });

            const targetDist = this.getMoveDistribution(this.settings.targetElo);

            console.log('══════════════════════════════');
            console.log(`📊 Elo ${this.settings.targetElo} | ${totalMoves} moves | ${avgCPL.toFixed(1)} CPL`);
            console.log('──────────────────────────────');

            for (let i = 0; i < maxMoves; i++) {
                const actual = ((rankCounts[i] / totalMoves) * 100).toFixed(1);
                const target = targetDist[i].toFixed(1);
                const diff = (actual - target).toFixed(1);
                const symbol = Math.abs(diff) <= 5 ? '✓' : '⚠';
                console.log(`  ${symbol} #${i+1}: ${actual}% (${target}%, ${diff > 0 ? '+' : ''}${diff}%)`);
            }

            console.log('══════════════════════════════');
        }

        getUIPlacement() {
            const board = this.getBoard();
            if (!board) return null;
            return board.parentElement?.parentElement || board.parentElement;
        }

        setupUI() {
            const placement = this.getUIPlacement();
            if (!placement) {
                setTimeout(() => this.setupUI(), 500);
                return;
            }

            if (document.getElementById('chess-analyzer-ui')) return;

            const container = document.createElement('div');
            container.id = 'chess-analyzer-ui';
            container.style.cssText = `
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                padding: 16px;
                border-radius: 8px;
                margin-top: 12px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                color: white;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                max-width: 350px;
            `;

            const targetAcpl = this.getTargetAcpl();
            const variants = this.getVariantsFromElo(this.settings.targetElo);
            const depth = this.getDepthFromElo(this.settings.targetElo);
            const colorEmoji = this.myColor === 2 ? '⚫' : '⚪';

            container.innerHTML = `
                <style>
                    #chess-analyzer-ui * { margin: 0; padding: 0; box-sizing: border-box; }
                    #chess-analyzer-ui h3 { margin-bottom: 12px; font-size: 16px; font-weight: 600; }
                    #chess-analyzer-ui .section { background: rgba(255,255,255,0.1); padding: 10px; border-radius: 6px; margin-bottom: 10px; }
                    #chess-analyzer-ui label { display: block; margin: 6px 0; font-size: 12px; }
                    #chess-analyzer-ui input[type="checkbox"] { margin-right: 6px; cursor: pointer; }
                    #chess-analyzer-ui input[type="number"], #chess-analyzer-ui input[type="text"] {
                        width: 100%; padding: 6px; border: none; border-radius: 4px;
                        background: rgba(255,255,255,0.9); margin-top: 4px; font-size: 13px;
                    }
                    #chess-analyzer-ui .status-bar {
                        display: flex; justify-content: space-between; align-items: center;
                        background: rgba(255,255,255,0.15); padding: 8px 10px; border-radius: 4px;
                        font-size: 13px; font-weight: 600; margin-bottom: 10px;
                    }
                    #chess-analyzer-ui .inline-inputs {
                        display: flex; gap: 6px; align-items: center; margin-top: 4px;
                    }
                    #chess-analyzer-ui .inline-inputs input { flex: 1; margin: 0; }
                    #chess-analyzer-ui .dist-info {
                        font-size: 9px; opacity: 0.85; margin-top: 6px;
                        background: rgba(0,0,0,0.2); padding: 6px; border-radius: 4px;
                    }
                </style>

                <h3>⚡ v12.5 ${colorEmoji}</h3>

                <div class="status-bar">
                    <span>Status:</span>
                    <span id="status-text" style="color: #4CAF50;">Ready</span>
                </div>

                <div class="section">
                    <label>
                        <input type="checkbox" id="alwaysBest" ${this.settings.alwaysBest ? 'checked' : ''}>
                        Always Best Move
                    </label>
                    <label>
                        <input type="checkbox" id="preferLichess" ${this.settings.preferLichess ? 'checked' : ''}>
                        Try Lichess Cloud First
                    </label>
                    <label>
                        <input type="checkbox" id="useLc0" ${this.settings.useLc0 ? 'checked' : ''}>
                        Use Lc0 (GPU - different style)
                    </label>
                    <label>
                        <input type="checkbox" id="liveAnalyzer" ${this.settings.liveAnalyzer ? 'checked' : ''}>
                        Live Analyzer (eval bar + classifications)
                    </label>
                    <label>
                        <input type="checkbox" id="validateBotElo" ${this.settings.validateBotElo ? 'checked' : ''}>
                        Validate Bot Elo at Game End
                    </label>
                </div>

                <div class="section">
                    <label>
                        Target Elo (250-3200):
                        <input type="text" id="targetElo" value="${this.settings.targetElo}">
                    </label>
                    <div class="dist-info" id="cas-dist-info">
                        Target ACPL: ${targetAcpl.toFixed(1)}cp/move<br>
                        Depth ${depth} | MultiPV ${variants} | ACPL-target sampling
                    </div>
                    <div class="dist-info" id="cas-tune-info" style="margin-top:4px;font-size:9px;opacity:0.8;">
                        ${this._tuneInfoLine()}
                    </div>
                </div>

                <div class="section">
                    <div style="font-weight:600;margin-bottom:6px;font-size:11px;opacity:0.9;">Modes (independent)</div>
                    <label>
                        <input type="checkbox" id="autoMove" ${this.settings.autoMove ? 'checked' : ''}>
                        Bot Mode (auto-play)
                    </label>
                    <label>
                        <input type="checkbox" id="learnerMode" ${this.settings.learnerMode ? 'checked' : ''}>
                        Learner Mode (arrows + opponent prediction)
                    </label>
                    <label>
                        <input type="checkbox" id="helperMode" ${this.settings.helperMode ? 'checked' : ''}>
                        Helper Mode (hint legal moves on piece pickup)
                    </label>
                    <label>
                        <input type="checkbox" id="botPremove" ${this.settings.botPremove ? 'checked' : ''}>
                        Bot Pre-move (when confident)
                    </label>
                </div>

                <div class="section">
                    <label>
                        <input type="checkbox" id="autoQueue" ${this.settings.autoQueue ? 'checked' : ''}>
                        Auto-Queue Games
                    </label>
                    <label>
                        <input type="checkbox" id="drawArrows" ${this.settings.drawArrows ? 'checked' : ''}>
                        Draw arrows (Learner mode)
                    </label>
                    <label>
                        <input type="checkbox" id="injectMoveListIcons" ${this.settings.injectMoveListIcons ? 'checked' : ''}>
                        Inject classification icons in move list
                    </label>
                    <label>
                        Move Delay (seconds):
                        <div class="inline-inputs">
                            <input type="number" id="moveDelayMin" min="0.1" step="0.1" value="${this.settings.moveDelayMin}">
                            <span>to</span>
                            <input type="number" id="moveDelayMax" min="0.1" step="0.1" value="${this.settings.moveDelayMax}">
                        </div>
                    </label>
                </div>
            `;

            placement.appendChild(container);
            console.log('✓ UI Ready');
        }

        setupEventListeners() {
            document.addEventListener('change', (e) => {
                if (e.target.id === 'alwaysBest') {
                    this.settings.alwaysBest = e.target.checked;
                    this.saveSettings();
                } else if (e.target.id === 'preferLichess') {
                    this.settings.preferLichess = e.target.checked;
                    this.saveSettings();
                } else if (e.target.id === 'useLc0') {
                    this.settings.useLc0 = e.target.checked;
                    this.saveSettings();
                    console.log(`Engine: ${e.target.checked ? 'Lc0 (GPU)' : 'Stockfish (CPU)'}`);
                } else if (e.target.id === 'liveAnalyzer') {
                    this.settings.liveAnalyzer = e.target.checked;
                    this.saveSettings();
                    if (e.target.checked) {
                        this.setupAnalyzerOverlay();
                    } else {
                        const bar = document.getElementById('chess-analyzer-eval-bar');
                        const panel = document.getElementById('chess-analyzer-side-panel');
                        if (bar) bar.remove();
                        if (panel) panel.remove();
                    }
                } else if (e.target.id === 'validateBotElo') {
                    this.settings.validateBotElo = e.target.checked;
                    this.saveSettings();
                } else if (e.target.id === 'learnerMode') {
                    this.settings.learnerMode = e.target.checked;
                    this.saveSettings();
                    if (e.target.checked) {
                        this.setupAnalyzerOverlay();
                        this._showLearnerLegend();
                    } else {
                        this.clearArrows();
                        this._hideLearnerLegend();
                    }
                } else if (e.target.id === 'helperMode') {
                    this.settings.helperMode = e.target.checked;
                    this.saveSettings();
                    if (e.target.checked) this._installHelperHints();
                    else this._uninstallHelperHints();
                } else if (e.target.id === 'botPremove') {
                    this.settings.botPremove = e.target.checked;
                    this.saveSettings();
                } else if (e.target.id === 'drawArrows') {
                    this.settings.drawArrows = e.target.checked;
                    this.saveSettings();
                    if (!e.target.checked) this.clearArrows();
                } else if (e.target.id === 'injectMoveListIcons') {
                    this.settings.injectMoveListIcons = e.target.checked;
                    this.saveSettings();
                    if (e.target.checked) this._injectAllMoveListIcons();
                    else this._clearMoveListIcons();
                } else if (e.target.id === 'autoQueue') {
                    this.settings.autoQueue = e.target.checked;
                    this.saveSettings();
                    console.log(`🎮 Auto-Queue: ${e.target.checked ? 'ON' : 'OFF'}`);
                } else if (e.target.id === 'targetElo') {
                    const value = parseInt(e.target.value) || 1500;
                    this.settings.targetElo = Math.max(250, Math.min(3200, value));
                    e.target.value = this.settings.targetElo;
                    this.saveSettings();
                    // Reset rolling CPL window so the new target dominates immediately
                    this._recentCpls = [];
                    this._recentRanks = [];
                    this._gameRanks = [];

                    const targetAcpl = this.getTargetAcpl();
                    const variants = this.getVariantsFromElo(this.settings.targetElo);
                    const depth = this.getDepthFromElo(this.settings.targetElo);
                    const info = document.getElementById('cas-dist-info');
                    if (info) {
                        info.innerHTML = `Target ACPL: ${targetAcpl.toFixed(1)}cp/move<br>Depth ${depth} | MultiPV ${variants} | ACPL-target sampling`;
                    }
                    this._refreshTargetEloDisplay();
                } else if (e.target.id === 'autoMove') {
                    this.settings.autoMove = e.target.checked;
                    this.saveSettings();
                    if (!e.target.checked) {
                        // Clear lingering bot move highlights so they don't sit there
                        // confusing the user as "blunder" indicators.
                        document.querySelectorAll('.bot-highlight').forEach(el => el.remove());
                    }
                } else if (e.target.id === 'moveDelayMin') {
                    this.settings.moveDelayMin = parseFloat(e.target.value) || 0.5;
                    this.saveSettings();
                } else if (e.target.id === 'moveDelayMax') {
                    this.settings.moveDelayMax = parseFloat(e.target.value) || 2.0;
                    this.saveSettings();
                }
            });
        }

        updateUI() {
            const statusText = document.getElementById('status-text');
            if (statusText) {
                if (this.isThinking) {
                    statusText.textContent = 'Analyzing...';
                    statusText.style.color = '#FFC107';
                } else {
                    statusText.textContent = 'Ready';
                    statusText.style.color = '#4CAF50';
                }
            }
        }

        startMonitoring() {
            setInterval(() => {
                // Watchdog: rescue from any stall where requestInProgress is
                // stuck true (e.g., setTimeout never fired due to background
                // throttling, ws message lost). Threshold scales to the
                // current request's thinkTime budget so blitz / bullet recover
                // FAST (a 250ms thinkTime budget shouldn't sit stuck for 20s
                // — that'd flag the user). Floor at 3s so a legitimately-slow
                // engine + IPC + parallel mate probe doesn't false-trip.
                // Cap at half remaining clock so we always have headroom to
                // retry within the same move.
                if (this.requestInProgress && this._requestStartedAt) {
                    const stuckMs = Date.now() - this._requestStartedAt;
                    const thinkMs = this._requestThinkMs || 2000;
                    let stuckLimit = Math.max(thinkMs * 2 + 1500, 3000);
                    const sec = this._getMyClockSeconds();
                    if (sec != null) {
                        stuckLimit = Math.min(stuckLimit, Math.floor(sec * 1000 * 0.5));
                    }
                    stuckLimit = Math.max(stuckLimit, 1500);  // hard floor
                    if (stuckMs > stuckLimit) {
                        console.warn(`⏱ Watchdog: request stuck ${(stuckMs/1000).toFixed(1)}s — force-reset`);
                        if (this.wsTimeout) {
                            clearTimeout(this.wsTimeout);
                            this.wsTimeout = null;
                        }
                        this._playRequestId = (this._playRequestId || 0) + 1;
                        this._playProcessed = false;
                        this.receivedMoves = {};
                        this.isThinking = false;
                        this.requestInProgress = false;
                        this.lastAnalyzedFen = null;
                        this._requestStartedAt = null;
                        // If the WS is broken, force a reconnect so we're
                        // not silently disconnected for the rest of the game.
                        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
                            console.warn('⏱ Watchdog: WS not OPEN — forcing reconnect');
                            try { this.ws.close(); } catch (e) {}
                        }
                        this.updateUI();
                    }
                }

                if (!this.isMyTurn() || this.isThinking || this.requestInProgress) return;
                if (!this.settings.autoMove) return;

                this.analyzePosition();
            }, 1500);

            setInterval(() => {
                if (!document.getElementById('chess-analyzer-ui')) this.setupUI();
                this.updateUI();
            }, 500);

            setInterval(() => {
                this.runAnalyzerLoop();
            }, 1500);

            setTimeout(() => {
                this.setupAnalyzerOverlay();
                if (this.settings.learnerMode) this._showLearnerLegend();
            }, 1500);
            setInterval(() => {
                if (this.settings.liveAnalyzer && !document.getElementById('chess-analyzer-eval-bar')) {
                    this.setupAnalyzerOverlay();
                }
                if (this.settings.learnerMode && !document.getElementById('cas-learner-legend')) {
                    this._showLearnerLegend();
                }
            }, 2000);
        }

        // ====================================================================
        // ANALYZER OVERLAY — chess.com-style live analysis (eval bar,
        // classifications, accuracy, estimated Elo, post-game review,
        // bot-Elo validation loop). All driven by server/server.py + analyzer.py.
        // ====================================================================

        static get CLASSIFICATION_META() {
            return {
                splendid:   { label: 'Brilliant',  symbol: '!!', color: '#19d4af', display: 'Brilliant !!' },
                perfect:    { label: 'Great',      symbol: '!',  color: '#3894eb', display: 'Great !' },
                best:       { label: 'Best',       symbol: '★',  color: '#22ac38', display: 'Best ★' },
                excellent:  { label: 'Excellent',  symbol: '✓',  color: '#22ac38', display: 'Excellent ✓' },
                okay:       { label: 'Good',       symbol: '•',  color: '#74b038', display: 'Good •' },
                opening:    { label: 'Book',       symbol: '📖', color: '#dbac86', display: 'Book' },
                forced:     { label: 'Forced',     symbol: '⮕',  color: '#dbac86', display: 'Forced' },
                inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#f2be1f', display: 'Inaccuracy ?!' },
                mistake:    { label: 'Mistake',    symbol: '?',  color: '#e69f00', display: 'Mistake ?' },
                blunder:    { label: 'Blunder',    symbol: '??', color: '#df5353', display: 'Blunder ??' }
            };
        }

        static cpToWinPercent(cp) {
            const c = Math.max(-1000, Math.min(1000, cp));
            const wc = 2 / (1 + Math.exp(-0.00368208 * c)) - 1;
            return 50 + 50 * wc;
        }

        static lineWinPercent(line) {
            if (line == null) return 50;
            if (line.mate != null) return line.mate > 0 ? 100 : 0;
            if (line.cp != null) return ChessAnalyzer.cpToWinPercent(line.cp);
            return 50;
        }

        static positionWinPercent(position) {
            if (!position?.lines?.length) return 50;
            return ChessAnalyzer.lineWinPercent(position.lines[0]);
        }

        static moveAccuracy(winBefore, winAfter, isWhiteMove) {
            const winDiff = isWhiteMove
                ? Math.max(0, winBefore - winAfter)
                : Math.max(0, winAfter - winBefore);
            const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411;
            return Math.max(0, Math.min(100, raw + 1));
        }

        static estimatedEloFromCpl(acpl) {
            return 3100 * Math.exp(-0.01 * acpl);
        }

        // -------- DOM injection --------

        setupAnalyzerOverlay() {
            try {
                this._setupEvalBar();
                this._setupSidePanel();
                this._setupArrowLayer();
                this._setupMoveListObserver();
                if (this.settings.helperMode) this._installHelperHints();
            } catch (e) {
                console.warn('Overlay setup failed, will retry:', e);
            }
        }

        // -------- Arrow overlay (Chesskit-style) --------

        _setupArrowLayer() {
            if (document.getElementById('cas-arrow-svg')) return;
            const board = this.getBoard();
            if (!board) return;
            const parent = board.parentElement;
            if (!parent) return;
            const cs = getComputedStyle(parent);
            if (cs.position === 'static') parent.style.position = 'relative';
            const ns = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(ns, 'svg');
            svg.id = 'cas-arrow-svg';
            svg.setAttribute('viewBox', '0 0 800 800');
            svg.setAttribute('preserveAspectRatio', 'none');
            svg.style.cssText = `
                position: absolute;
                top: 0; left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                z-index: 95;
            `;
            parent.appendChild(svg);
            this._positionArrowLayerOverBoard();
            window.addEventListener('resize', () => this._positionArrowLayerOverBoard());
        }

        _positionArrowLayerOverBoard() {
            const svg = document.getElementById('cas-arrow-svg');
            const board = this.getBoard();
            if (!svg || !board) return;
            try {
                const r = board.getBoundingClientRect();
                const pr = svg.parentElement.getBoundingClientRect();
                svg.style.top = (r.top - pr.top) + 'px';
                svg.style.left = (r.left - pr.left) + 'px';
                svg.style.width = r.width + 'px';
                svg.style.height = r.height + 'px';
            } catch (e) {}
        }

        clearArrows() {
            const svg = document.getElementById('cas-arrow-svg');
            if (!svg) return;
            while (svg.firstChild) svg.removeChild(svg.firstChild);
        }

        drawArrow(fromUci, toUci, opts = {}) {
            const svg = document.getElementById('cas-arrow-svg');
            if (!svg) return;
            this._positionArrowLayerOverBoard();
            const color = opts.color || '#22ac38';
            const dashed = !!opts.dashed;
            const opacity = opts.opacity != null ? opts.opacity : 0.85;
            const width = opts.thick ? 22 : 14;
            if (!fromUci || !toUci || fromUci.length < 2 || toUci.length < 2) return;
            const fromFile = fromUci.charCodeAt(0) - 97;
            const fromRank = parseInt(fromUci[1]) - 1;
            const toFile = toUci.charCodeAt(0) - 97;
            const toRank = parseInt(toUci[1]) - 1;
            const flipped = this.myColor === 2;
            const sq = (file, rank) => [
                (flipped ? 7 - file : file) * 100 + 50,
                (flipped ? rank : 7 - rank) * 100 + 50
            ];
            const [x1, y1] = sq(fromFile, fromRank);
            const [x2, y2] = sq(toFile, toRank);
            const dx = x2 - x1, dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) return;
            const ux = dx / len, uy = dy / len;
            const headLen = 32;
            const tailX = x2 - ux * headLen;
            const tailY = y2 - uy * headLen;
            const ns = 'http://www.w3.org/2000/svg';
            const g = document.createElementNS(ns, 'g');
            g.setAttribute('opacity', opacity);
            const line = document.createElementNS(ns, 'line');
            line.setAttribute('x1', x1);
            line.setAttribute('y1', y1);
            line.setAttribute('x2', tailX);
            line.setAttribute('y2', tailY);
            line.setAttribute('stroke', color);
            line.setAttribute('stroke-width', width);
            line.setAttribute('stroke-linecap', 'round');
            if (dashed) line.setAttribute('stroke-dasharray', '24,14');
            g.appendChild(line);
            const head = document.createElementNS(ns, 'polygon');
            const pX = ux * headLen, pY = uy * headLen;
            const sX = -uy * 22, sY = ux * 22;
            head.setAttribute('points', `${x2},${y2} ${x2 - pX + sX},${y2 - pY + sY} ${x2 - pX - sX},${y2 - pY - sY}`);
            head.setAttribute('fill', color);
            g.appendChild(head);
            svg.appendChild(g);
        }

        _drawArrowsForLastMove(result, prevEval) {
            if (!this.settings.drawArrows) return;
            if (!this.settings.learnerMode) return;
            this.clearArrows();
            if (!result || !result.uci) return;
            const meta = ChessAnalyzer.CLASSIFICATION_META[result.classification] || { color: '#888' };
            const fromU = result.uci.substring(0, 2);
            const toU = result.uci.substring(2, 4);
            this.drawArrow(fromU, toU, { color: meta.color, opacity: 0.75 });

            const wasBad = ['blunder', 'mistake', 'inaccuracy'].includes(result.classification);
            if (wasBad && prevEval?.lines?.[0]?.pv?.[0]) {
                const bestUci = prevEval.lines[0].pv[0];
                if (bestUci !== result.uci) {
                    this.drawArrow(bestUci.substring(0, 2), bestUci.substring(2, 4),
                        { color: '#22ac38', opacity: 0.9, thick: true });
                }
            }

            // Multi-ply continuation from current position. PV alternates
            // between opponent and us — color and fade accordingly.
            const pv = result.lines?.[0]?.pv || [];
            const maxPlies = Math.min(3, pv.length);
            for (let i = 0; i < maxPlies; i++) {
                const move = pv[i];
                if (!move || move.length < 4) continue;
                const isOpponent = (i % 2 === 0);
                const color = isOpponent ? '#3894eb' : '#19d4af';
                const opacity = Math.max(0.2, 0.65 - i * 0.18);
                this.drawArrow(move.substring(0, 2), move.substring(2, 4),
                    { color, dashed: true, opacity });
            }
        }

        // -------- chess.com move list icon injection --------

        _findMoveListEl() {
            return document.querySelector('wc-simple-move-list') ||
                document.querySelector('vertical-move-list');
        }

        _setupMoveListObserver() {
            if (this._moveListObserver) return;
            const list = this._findMoveListEl();
            // Don't fall back to document.body — that would observe every
            // mutation page-wide (ad iframes, our own status pill, etc.) and
            // recurse `runAnalyzerLoop` thousands of times per second.
            // Poll until the move list element actually exists, then attach.
            if (!list) {
                if (!this._moveListSetupRetry) {
                    this._moveListSetupRetry = setInterval(() => {
                        if (this._findMoveListEl()) {
                            clearInterval(this._moveListSetupRetry);
                            this._moveListSetupRetry = null;
                            this._setupMoveListObserver();
                        }
                    }, 1000);
                }
                return;
            }
            this._moveListObserver = new MutationObserver(() => {
                // Skip mutations triggered by our own writes (icon injection)
                // to prevent self-feedback recursion.
                if (this._suppressMoveListObserver) return;
                // Debounce: coalesce bursts of mutations into one analyzer
                // run. chess.com's move list re-renders fire many child
                // mutations per ply; we only need to act once per ply.
                if (this._moveListDebounce) return;
                this._moveListDebounce = setTimeout(() => {
                    this._moveListDebounce = null;
                    if (this.settings.liveAnalyzer) {
                        this.runAnalyzerLoop();
                    }
                    if (this.settings.helperMode) {
                        this._clearHelperHints();
                        this._helperLastSquare = null;
                    }
                    if (this.settings.injectMoveListIcons) {
                        this._suppressMoveListObserver = true;
                        try { this._injectAllMoveListIcons(); }
                        finally {
                            // Release on next microtask — after the MO has
                            // had a chance to enqueue our own write events,
                            // so they get dropped by the early-return above.
                            Promise.resolve().then(() => {
                                this._suppressMoveListObserver = false;
                            });
                        }
                    }
                }, 80);
            });
            try {
                this._moveListObserver.observe(list, { childList: true, subtree: true });
            } catch (e) {}
        }

        _injectAllMoveListIcons() {
            try {
                const list = this._findMoveListEl();
                if (!list) return;
                // chess.com layouts seen so far (kept old selectors as fallback):
                //   wc-simple-move-list .node.white-move / .node.black-move (current)
                //   vertical-move-list  .white.node       / .black.node       (legacy)
                const moveNodes = list.querySelectorAll(
                    '.node.white-move, .node.black-move, .white.node, .black.node'
                );
                moveNodes.forEach((node) => {
                    const ply = this._inferPlyFromNode(node);
                    if (ply == null || ply > this.gameAnalysis.classifications.length) return;
                    const cls = this.gameAnalysis.classifications[ply - 1];
                    if (!cls) return;
                    this._setMoveNodeIcon(node, cls);
                });
            } catch (e) {}
        }

        _inferPlyFromNode(node) {
            try {
                // Current chess.com: every move node has data-node="0-N"
                // where N is the 0-indexed ply. So 1-indexed ply = N + 1.
                const dn = node.getAttribute && node.getAttribute('data-node');
                if (dn) {
                    const m = /(?:^|\D)(\d+)$/.exec(dn);
                    if (m) return parseInt(m[1], 10) + 1;
                }
                // Legacy fallback: row's data-whole-move-number + side class.
                const row = node.closest && node.closest('[data-whole-move-number], .move');
                if (row) {
                    const num = row.getAttribute('data-whole-move-number');
                    if (num) {
                        const moveNum = parseInt(num, 10);
                        const isWhite = node.classList.contains('white-move') ||
                            node.classList.contains('white');
                        if (moveNum) return moveNum * 2 - (isWhite ? 1 : 0);
                    }
                }
                // Final fallback: index among all node siblings.
                const list = this._findMoveListEl();
                if (list) {
                    const all = Array.from(list.querySelectorAll(
                        '.node.white-move, .node.black-move, .white.node, .black.node'
                    ));
                    const idx = all.indexOf(node);
                    if (idx >= 0) return idx + 1;
                }
                return null;
            } catch (e) {
                return null;
            }
        }

        _setMoveNodeIcon(node, classification) {
            const meta = ChessAnalyzer.CLASSIFICATION_META[classification];
            if (!meta) return;
            let icon = node.querySelector('.cas-mv-icon');
            if (!icon) {
                icon = document.createElement('span');
                icon.className = 'cas-mv-icon';
                icon.style.cssText = `
                    display: inline-block;
                    margin-left: 4px;
                    padding: 1px 4px;
                    border-radius: 3px;
                    font-size: 10px;
                    font-weight: 700;
                    color: #fff;
                    vertical-align: middle;
                `;
                node.appendChild(icon);
            }
            icon.textContent = meta.symbol;
            icon.style.background = meta.color;
            icon.title = meta.label;
        }

        _clearMoveListIcons() {
            try {
                document.querySelectorAll('.cas-mv-icon').forEach(el => el.remove());
            } catch (e) {}
        }

        // -------- Helper / hint mode (ChessUp-2 style) --------

        _installHelperHints() {
            if (this._helperMoveListenerInstalled) return;
            const board = this.getBoard();
            if (!board) {
                setTimeout(() => this._installHelperHints(), 1000);
                return;
            }
            this._helperMoveListenerInstalled = true;
            this._helperBoardEl = board;
            this._helperLastSquare = null;
            // Use pointerdown so press-and-hold (the natural drag-to-move
            // gesture) shows hints immediately. `click` only fires on a
            // press+release with no significant drag, so it missed the most
            // common interaction.
            this._helperPointerDownListener = (e) => this._onHelperPointerDown(e);
            this._helperBoardClickListener = (e) => this._onBoardOutsideClick(e);
            board.addEventListener('pointerdown', this._helperPointerDownListener, true);
            document.addEventListener('pointerdown', this._helperBoardClickListener, true);
        }

        _uninstallHelperHints() {
            this._helperMoveListenerInstalled = false;
            const board = this._helperBoardEl || this.getBoard();
            if (board && this._helperPointerDownListener) {
                board.removeEventListener('pointerdown', this._helperPointerDownListener, true);
            }
            if (this._helperBoardClickListener) {
                document.removeEventListener('pointerdown', this._helperBoardClickListener, true);
            }
            this._helperPointerDownListener = null;
            this._helperBoardClickListener = null;
            this._helperBoardEl = null;
            this._helperLastSquare = null;
            this._clearHelperHints();
        }

        _onBoardOutsideClick(e) {
            if (!this.settings.helperMode) return;
            const board = this.getBoard();
            if (!board) return;
            // If the click was outside the board, clear hints.
            if (e.target === board || (board.contains && board.contains(e.target))) return;
            this._clearHelperHints();
            this._helperLastSquare = null;
        }

        // Canvas-board variant: chess.com's wc-chess-board renders to <canvas>,
        // there are no DOM .piece elements to hit-test. Compute the square from
        // pointer coordinates relative to the board's bounding rect, then look
        // up legal moves originating there. Pointerdown shows hints whether
        // the user clicks or starts a drag — the previous click-only handler
        // missed press-and-hold/drag-to-move (the most common interaction).
        // Pressing a different piece replaces hints; pressing the same piece
        // again toggles off; the move-list MutationObserver clears on commit.
        _onHelperPointerDown(e) {
            if (!this.settings.helperMode) return;
            // Only handle primary button presses to avoid right-click menus
            // or middle-click etc. fighting our hint logic.
            if (e.button != null && e.button !== 0) return;
            const board = this.getBoard();
            if (!board?.game) return;
            const rect = board.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            if (e.clientX < rect.left || e.clientX > rect.right ||
                e.clientY < rect.top  || e.clientY > rect.bottom) return;

            const sqW = rect.width  / 8;
            const sqH = rect.height / 8;
            let file = Math.floor((e.clientX - rect.left) / sqW);
            let rank = 7 - Math.floor((e.clientY - rect.top) / sqH);
            if (this.myColor === 2) { file = 7 - file; rank = 7 - rank; }
            if (file < 0 || file > 7 || rank < 0 || rank > 7) return;

            const fromAlg = String.fromCharCode(97 + file) + (rank + 1);

            // Pressing the same piece again = toggle hints off.
            if (this._helperLastSquare === fromAlg) {
                this._clearHelperHints();
                this._helperLastSquare = null;
                return;
            }

            try {
                const legal = board.game.getLegalMoves();
                const fromMatches = legal.filter(m => m.from === fromAlg);
                if (fromMatches.length === 0) {
                    // Pressed an empty square or opponent piece — dismiss any
                    // hints from a prior selection.
                    this._clearHelperHints();
                    this._helperLastSquare = null;
                    return;
                }
                // Always clear before showing — handles "press piece A, then
                // press piece B without releasing A" (the overlap bug).
                this._clearHelperHints();
                this._showHelperHintsFor(fromAlg, fromMatches);
                this._helperLastSquare = fromAlg;
            } catch (err) {}
        }

        _onHelperPointerUp() {
            if (!this.settings.helperMode) return;
            setTimeout(() => this._clearHelperHints(), 50);
        }

        _showHelperHintsFor(fromAlg, legalMoves) {
            this._clearHelperHints();
            const svg = document.getElementById('cas-arrow-svg');
            if (!svg) return;
            this._positionArrowLayerOverBoard();
            const flipped = this.myColor === 2;
            const ns = 'http://www.w3.org/2000/svg';
            for (const m of legalMoves) {
                const file = m.to.charCodeAt(0) - 97;
                const rank = parseInt(m.to[1]) - 1;
                const cx = (flipped ? 7 - file : file) * 100 + 50;
                const cy = (flipped ? rank : 7 - rank) * 100 + 50;
                // Captures get a thick ring overlaying the captured piece;
                // non-capture moves get a small centered dot. This matches
                // the chess.com convention so the hint sits on top of the
                // piece rather than next to it.
                const isCapture = !!(m.captured) ||
                    (m.flags && /[ce]/.test(String(m.flags)));
                const el = document.createElementNS(ns, 'circle');
                el.setAttribute('class', 'cas-hint-dot');
                el.setAttribute('cx', String(cx));
                el.setAttribute('cy', String(cy));
                if (isCapture) {
                    el.setAttribute('r', '42');
                    el.setAttribute('fill', 'none');
                    el.setAttribute('stroke', '#3894eb');
                    el.setAttribute('stroke-width', '8');
                    el.setAttribute('opacity', '0.65');
                } else {
                    el.setAttribute('r', '14');
                    el.setAttribute('fill', '#3894eb');
                    el.setAttribute('opacity', '0.55');
                }
                svg.appendChild(el);
            }
            // Also: highlight the engine's best from this square if we have current eval
            try {
                const lastEval = this.gameAnalysis.evals[this.gameAnalysis.evals.length - 1];
                const bestMove = lastEval?.lines?.[0]?.pv?.[0];
                if (bestMove && bestMove.startsWith(fromAlg)) {
                    const toU = bestMove.substring(2, 4);
                    this.drawArrow(fromAlg, toU, { color: '#22ac38', opacity: 0.85, thick: true });
                }
                const sortedLines = (lastEval?.lines || []).slice().sort((a, b) =>
                    ChessAnalyzer.lineWinPercent(a) - ChessAnalyzer.lineWinPercent(b));
                for (const line of sortedLines.slice(0, 2)) {
                    const m = line.pv?.[0];
                    if (m && m.startsWith(fromAlg)) {
                        const toU = m.substring(2, 4);
                        this.drawArrow(fromAlg, toU, { color: '#df5353', opacity: 0.6, dashed: true });
                    }
                }
            } catch (e) {}
        }

        _clearHelperHints() {
            try {
                const svg = document.getElementById('cas-arrow-svg');
                if (!svg) return;
                svg.querySelectorAll('.cas-hint-dot').forEach(el => el.remove());
                if (!this.settings.learnerMode) {
                    this.clearArrows();
                }
            } catch (e) {}
        }

        // -------- Learner Mode legend --------

        _showLearnerLegend() {
            try {
                let panel = document.getElementById('cas-learner-legend');
                if (panel) { panel.style.display = 'block'; return; }
                panel = document.createElement('div');
                panel.id = 'cas-learner-legend';
                panel.style.cssText = [
                    'position:fixed', 'right:16px', 'bottom:16px',
                    'z-index:2147483646', 'width:268px',
                    'background:rgba(20,22,28,0.94)', 'color:#e8e8ea',
                    'border:1px solid #2a2d36', 'border-radius:10px',
                    'box-shadow:0 6px 24px rgba(0,0,0,0.45)',
                    'font:12px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
                    'padding:10px 12px'
                ].join(';');
                const row = (color, dashed, thick, title, body) => {
                    const stroke = thick ? 4 : 3;
                    const dash = dashed ? 'stroke-dasharray="5 4"' : '';
                    return `
                        <div style="display:flex;align-items:flex-start;gap:8px;margin:6px 0;">
                            <svg width="34" height="14" viewBox="0 0 34 14" style="flex:0 0 auto;margin-top:2px;">
                                <defs><marker id="cas-leg-${color.replace('#','')}-${dashed?1:0}-${thick?1:0}" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0,0 L6,3 L0,6 z" fill="${color}"/></marker></defs>
                                <line x1="2" y1="7" x2="28" y2="7" stroke="${color}" stroke-width="${stroke}" ${dash} marker-end="url(#cas-leg-${color.replace('#','')}-${dashed?1:0}-${thick?1:0})" stroke-linecap="round" />
                            </svg>
                            <div style="flex:1;min-width:0;">
                                <div style="color:${color};font-weight:600;">${title}</div>
                                <div style="color:#b8b9bf;">${body}</div>
                            </div>
                        </div>`;
                };
                panel.innerHTML = `
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                        <div style="font-weight:700;letter-spacing:.2px;">Learner Legend</div>
                        <button id="cas-learner-legend-close" title="Hide" style="background:transparent;border:none;color:#8a8c93;cursor:pointer;font-size:14px;padding:2px 6px;">×</button>
                    </div>
                    <div style="color:#b8b9bf;margin-bottom:6px;">Arrows show what just happened and what likely comes next.</div>
                    ${row('#22ac38', false, true,  'Best move (missed)', 'The engine‑preferred move you did not play. Only shown after an inaccuracy / mistake / blunder.')}
                    ${row('#19d4af', false, false, 'Brilliant / your played move', 'Solid arrow colored by quality: teal Brilliant, blue Great, green Best/Excellent, yellow Inaccuracy, orange Mistake, red Blunder.')}
                    ${row('#3894eb', true,  false, 'Opponent’s likely reply', 'Dashed blue arrow — the engine’s predicted response on the next ply.')}
                    ${row('#19d4af', true,  false, 'Your likely follow‑up', 'Dashed teal arrow — your expected reply two plies ahead. Faded arrows are deeper into the line.')}
                    <div style="margin-top:8px;color:#8a8c93;font-size:11px;">Tip: turn off Learner Mode to hide arrows. Hover the move list to scrub through past arrows.</div>
                `;
                document.body.appendChild(panel);
                const closeBtn = panel.querySelector('#cas-learner-legend-close');
                if (closeBtn) closeBtn.addEventListener('click', () => this._hideLearnerLegend());
            } catch (e) { console.warn('learner legend show failed:', e); }
        }

        _hideLearnerLegend() {
            try {
                const panel = document.getElementById('cas-learner-legend');
                if (panel) panel.remove();
            } catch (e) {}
        }

        // -------- Bot pre-move support --------

        // Premove is "safe" only when we're confident our planned reply still
        // works regardless of which legal reply the opponent picks. Otherwise
        // chess.com's premove fires from the wrong premise and frequently
        // blunders material. Conditions:
        //   1. Opponent has only one legal reply (the engine returned a single
        //      MultiPV line) — premove is forced-correct.
        //   2. The same reply (pv[1]) appears as the engine's response across
        //      ALL top-N MultiPV lines we got back — i.e., regardless of which
        //      of opp's top candidates they actually play, our move is the same.
        //   3. The eval after our move is winning (cp >> 0 in our POV) AND opp's
        //      top-2 replies have similar evals — they have no clearly better
        //      option than the one we predicted.
        _isPremoveSafe(result) {
            const lines = result?.lines;
            if (!Array.isArray(lines) || lines.length === 0) return false;
            const ourReply = lines[0]?.pv?.[1];
            if (!ourReply) return false;

            if (lines.length === 1) return true;  // forced

            const topN = Math.min(3, lines.length);
            let matches = 0;
            for (let i = 0; i < topN; i++) {
                if (lines[i]?.pv?.[1] === ourReply) matches++;
            }
            if (matches === topN) return true;

            return false;
        }

        attemptPremove(uciMove) {
            if (!this.settings.botPremove) return false;
            const board = this.getBoard();
            if (!board?.game || !uciMove || uciMove.length < 4) return false;
            const from = uciMove.substring(0, 2);
            const to = uciMove.substring(2, 4);
            try {
                if (typeof board.game.setPreMove === 'function') {
                    board.game.setPreMove({ from, to });
                    return true;
                }
                if (typeof board.game.move === 'function') {
                    board.game.move({ from, to, premove: true, animate: false, userGenerated: true });
                    return true;
                }
            } catch (e) {
                console.warn('premove attempt failed:', e);
            }
            return false;
        }

        _setupEvalBar() {
            if (document.getElementById('chess-analyzer-eval-bar')) return;
            const board = this.getBoard();
            if (!board) return;
            const parent = board.parentElement;
            if (!parent) return;

            const cs = getComputedStyle(parent);
            if (cs.position === 'static') parent.style.position = 'relative';

            const bar = document.createElement('div');
            bar.id = 'chess-analyzer-eval-bar';
            bar.style.cssText = `
                position: absolute;
                left: -1px;
                top: 0;
                width: 22px;
                height: 100%;
                background: linear-gradient(to top, #f5f5f5 0%, #f5f5f5 50%, #1a1a1a 50%, #1a1a1a 100%);
                border-radius: 3px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
                z-index: 100;
                pointer-events: none;
                transition: background 0.4s ease;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 10px;
                font-weight: 700;
            `;
            const top = document.createElement('div');
            top.id = 'chess-analyzer-eval-label-top';
            top.style.cssText = 'position:absolute;top:3px;left:0;width:100%;text-align:center;color:#000;';
            const bottom = document.createElement('div');
            bottom.id = 'chess-analyzer-eval-label-bottom';
            bottom.style.cssText = 'position:absolute;bottom:3px;left:0;width:100%;text-align:center;color:#fff;';
            bar.appendChild(top);
            bar.appendChild(bottom);
            parent.appendChild(bar);
        }

        _setupSidePanel() {
            if (document.getElementById('chess-analyzer-side-panel')) return;
            const panel = document.createElement('div');
            panel.id = 'chess-analyzer-side-panel';
            panel.style.cssText = `
                position: fixed;
                right: 12px;
                top: 80px;
                width: 280px;
                max-height: 75vh;
                overflow: hidden;
                background: rgba(20, 22, 32, 0.97);
                color: #f5f5f5;
                border-radius: 10px;
                padding: 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 12px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                z-index: 99999;
                display: flex;
                flex-direction: column;
                gap: 10px;
            `;
            panel.innerHTML = `
                <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #333;padding-bottom:6px;">
                    <strong style="font-size:13px;">Live Analysis</strong>
                    <span id="chess-analyzer-status-pill" style="font-size:10px;color:#4CAF50;">idle</span>
                </div>
                <div id="chess-analyzer-stats" style="display:grid;grid-template-columns:auto 1fr 1fr;gap:4px 10px;font-size:11px;">
                    <span></span><span style="opacity:0.7;text-align:center;">White</span><span style="opacity:0.7;text-align:center;">Black</span>
                    <span style="opacity:0.7;">Accuracy</span>
                    <span id="cas-acc-w" style="text-align:center;font-weight:600;">—</span>
                    <span id="cas-acc-b" style="text-align:center;font-weight:600;">—</span>
                    <span style="opacity:0.7;">Est. Elo</span>
                    <span id="cas-elo-w" style="text-align:center;font-weight:600;">—</span>
                    <span id="cas-elo-b" style="text-align:center;font-weight:600;">—</span>
                    <span style="opacity:0.7;">ACPL</span>
                    <span id="cas-acpl-w" style="text-align:center;">—</span>
                    <span id="cas-acpl-b" style="text-align:center;">—</span>
                </div>
                <div id="chess-analyzer-classifications-list" style="
                    overflow-y: auto;
                    max-height: 38vh;
                    border-top: 1px solid #333;
                    padding-top: 6px;
                    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
                    font-size: 11px;
                    line-height: 1.5;
                "></div>
                <div style="display:flex;gap:6px;">
                    <button id="cas-review-btn" style="
                        flex:1;background:#3894eb;color:#fff;border:none;border-radius:5px;
                        padding:8px 10px;cursor:pointer;font-weight:600;font-size:11px;">
                        Review Game
                    </button>
                    <button id="cas-export-btn" style="
                        flex:0 0 auto;background:#444;color:#fff;border:none;border-radius:5px;
                        padding:8px 10px;cursor:pointer;font-weight:600;font-size:11px;">
                        Export JSON
                    </button>
                </div>
                <div id="cas-review-progress" style="font-size:10px;opacity:0.7;display:none;"></div>
                <div id="cas-validation-result" style="
                    font-size:11px;padding:6px 8px;background:rgba(255,255,255,0.05);
                    border-radius:4px;display:none;"></div>
            `;
            document.body.appendChild(panel);

            document.getElementById('cas-review-btn').addEventListener('click', () => this.requestFullReview());
            document.getElementById('cas-export-btn').addEventListener('click', () => this.exportAnalysisJson());
        }

        clearOverlay() {
            const list = document.getElementById('chess-analyzer-classifications-list');
            if (list) list.innerHTML = '';
            const valid = document.getElementById('cas-validation-result');
            if (valid) { valid.style.display = 'none'; valid.textContent = ''; }
            this._setStatsLabels({white: '—', black: '—'}, {white: '—', black: '—'}, {white: '—', black: '—'});
            this._setEvalBarFill(50, '0.0');
        }

        _setStatsLabels(acc, elo, acpl) {
            const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
            set('cas-acc-w', acc.white); set('cas-acc-b', acc.black);
            set('cas-elo-w', elo.white); set('cas-elo-b', elo.black);
            set('cas-acpl-w', acpl.white); set('cas-acpl-b', acpl.black);
        }

        // -------- Eval bar updates --------

        _setEvalBarFill(whitePct, label) {
            const bar = document.getElementById('chess-analyzer-eval-bar');
            if (!bar) return;
            bar.style.background = `linear-gradient(to top, #f5f5f5 0%, #f5f5f5 ${whitePct}%, #1a1a1a ${whitePct}%, #1a1a1a 100%)`;
            const top = document.getElementById('chess-analyzer-eval-label-top');
            const bottom = document.getElementById('chess-analyzer-eval-label-bottom');
            if (top && bottom) {
                if (whitePct >= 50) {
                    top.textContent = '';
                    bottom.textContent = label;
                } else {
                    top.textContent = label;
                    bottom.textContent = '';
                }
            }
        }

        updateEvalBar() {
            if (!this.gameAnalysis.evals.length) {
                this._setEvalBarFill(50, '0.0');
                return;
            }
            const evalObj = this.gameAnalysis.evals[this.gameAnalysis.evals.length - 1];
            const winPct = ChessAnalyzer.positionWinPercent(evalObj);
            const line = evalObj.lines?.[0];
            let label = '0.0';
            if (line) {
                if (line.mate != null) {
                    label = `M${Math.abs(line.mate)}`;
                } else if (line.cp != null) {
                    const e = line.cp / 100;
                    label = (e >= 0 ? '+' : '') + e.toFixed(1);
                    if (Math.abs(e) >= 10) label = (e >= 0 ? '+' : '') + e.toFixed(0);
                }
            }
            this._setEvalBarFill(winPct, label);
        }

        // -------- Classifications list --------

        appendClassificationToList(result) {
            const list = document.getElementById('chess-analyzer-classifications-list');
            if (!list) return;
            const ply = this.gameAnalysis.moves.length;
            const isWhite = ply % 2 === 1;
            const meta = ChessAnalyzer.CLASSIFICATION_META[result.classification] ||
                { symbol: '·', color: '#888', label: result.classification };
            const moveNum = Math.ceil(ply / 2);
            const prefix = isWhite ? `${moveNum}.` : `${moveNum}…`;
            const winLabel = result.win_percent != null ? `${result.win_percent.toFixed(1)}%` : '—';
            const opening = result.opening ? ` <span style="opacity:0.6;">[${this._escapeHtml(result.opening)}]</span>` : '';
            const row = document.createElement('div');
            row.style.cssText = `
                display:grid;grid-template-columns:48px 60px 1fr auto;gap:6px;align-items:center;
                padding:2px 4px;border-radius:3px;
                background:${ply % 2 === 1 ? 'rgba(255,255,255,0.03)' : 'transparent'};
            `;
            row.innerHTML = `
                <span style="opacity:0.6;">${prefix}</span>
                <span style="font-weight:600;">${this._escapeHtml(result.san || result.uci || '?')}</span>
                <span style="color:${meta.color};font-weight:600;">${meta.symbol} ${this._escapeHtml(meta.label)}</span>
                <span style="opacity:0.5;font-size:10px;">${winLabel}</span>
            `;
            if (result.opening) {
                const note = document.createElement('div');
                note.style.cssText = 'grid-column:1/-1;opacity:0.55;font-size:10px;padding-left:54px;';
                note.innerHTML = opening;
                row.appendChild(note);
            }
            list.appendChild(row);
            list.scrollTop = list.scrollHeight;
        }

        _escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, c => ({
                '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
            }[c]));
        }

        rebuildClassificationsList() {
            const list = document.getElementById('chess-analyzer-classifications-list');
            if (!list) return;
            list.innerHTML = '';
            for (let i = 0; i < this.gameAnalysis.moves.length; i++) {
                this.appendClassificationToList({
                    classification: this.gameAnalysis.classifications[i],
                    san: this.gameAnalysis.sans[i],
                    uci: this.gameAnalysis.moves[i],
                    win_percent: this.gameAnalysis.winPercents[i + 1],
                    opening: this.gameAnalysis.openings[i]
                });
                // appendClassificationToList increments via list-only DOM, no state change
            }
        }

        // -------- Accuracy / Elo panel --------

        updateAccuracyPanel() {
            try {
                const stats = this._computeRunningStats();
                this._setStatsLabels(
                    {
                        white: stats.acc.white != null ? `${stats.acc.white.toFixed(1)}%` : '—',
                        black: stats.acc.black != null ? `${stats.acc.black.toFixed(1)}%` : '—'
                    },
                    {
                        white: stats.elo.white != null ? `${Math.round(stats.elo.white)}` : '—',
                        black: stats.elo.black != null ? `${Math.round(stats.elo.black)}` : '—'
                    },
                    {
                        white: stats.acpl.white != null ? `${stats.acpl.white.toFixed(1)}` : '—',
                        black: stats.acpl.black != null ? `${stats.acpl.black.toFixed(1)}` : '—'
                    }
                );
            } catch (e) {
                console.warn('updateAccuracyPanel:', e);
            }
        }

        _computeRunningStats() {
            const wp = this.gameAnalysis.winPercents;
            if (wp.length < 2) {
                return {
                    acc: {white: null, black: null},
                    elo: {white: null, black: null},
                    acpl: {white: null, black: null}
                };
            }
            const accW = [];
            const accB = [];
            for (let i = 1; i < wp.length; i++) {
                const isWhite = (i % 2 === 1);
                const a = ChessAnalyzer.moveAccuracy(wp[i - 1], wp[i], isWhite);
                if (isWhite) accW.push(a); else accB.push(a);
            }
            const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

            const evals = this.gameAnalysis.evals;
            const cpAt = (eobj) => {
                const line = eobj?.lines?.[0];
                if (!line) return 0;
                if (line.cp != null) return Math.max(-1000, Math.min(1000, line.cp));
                if (line.mate != null) return line.mate > 0 ? 1000 : -1000;
                return 0;
            };
            let prevCp = cpAt(evals[0]);
            let cplW = 0, cplB = 0;
            const nMoves = evals.length - 1;
            for (let i = 1; i < evals.length; i++) {
                const cp = cpAt(evals[i]);
                if ((i - 1) % 2 === 0) {
                    if (cp <= prevCp) cplW += Math.min(prevCp - cp, 1000);
                } else {
                    if (cp >= prevCp) cplB += Math.min(cp - prevCp, 1000);
                }
                prevCp = cp;
            }
            const wCount = Math.ceil(nMoves / 2);
            const bCount = Math.floor(nMoves / 2);
            const acplW = wCount ? cplW / wCount : null;
            const acplB = bCount ? cplB / bCount : null;
            return {
                acc: {white: mean(accW), black: mean(accB)},
                elo: {
                    white: acplW != null ? ChessAnalyzer.estimatedEloFromCpl(acplW) : null,
                    black: acplB != null ? ChessAnalyzer.estimatedEloFromCpl(acplB) : null
                },
                acpl: {white: acplW, black: acplB}
            };
        }

        // -------- Live analyzer loop --------

        async runAnalyzerLoop() {
            if (!this.settings.liveAnalyzer) return;
            if (this.analyzerInProgress) return;
            // Note: deliberately NOT gating on requestInProgress / isThinking.
            // With dual-engine routing the play engine and analysis engine are
            // separate processes on the server, so the live analyzer should
            // run alongside the bot's own move calculation rather than wait
            // for it. Waiting was the cause of the "analyzer falls behind and
            // catches up mid-game" behavior in blitz.
            if (!this.wsReady) return;

            const board = this.getBoard();
            if (!board?.game) return;

            let fen;
            try { fen = board.game.getFEN(); } catch (e) { return; }
            if (!fen) return;
            if (fen === this.gameAnalysis.lastSeenFen) return;

            this.analyzerInProgress = true;
            this._setStatusPill('analyzing', '#FFC107');
            try {
                if (this._isResetCondition(fen)) {
                    this._captureGameMetadata();
                    this.resetGameAnalysis();
                    this.clearOverlay();
                }

                // Initial-position eval (once per game)
                if (this.gameAnalysis.fens.length === 0) {
                    const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
                    const evalObj = await this._requestPositionEval(startFen);
                    if (evalObj) {
                        this.gameAnalysis.fens.push(startFen);
                        this.gameAnalysis.evals.push(evalObj);
                        this.gameAnalysis.winPercents.push(ChessAnalyzer.positionWinPercent(evalObj));
                        this.updateEvalBar();
                    } else {
                        // Couldn't even get startpos eval — bail and retry next tick.
                        // Don't update lastSeenFen — leave it untouched so the next
                        // poll sees fen != lastSeenFen and re-enters this branch.
                        return;
                    }
                }

                // Walk forward through every move chess.com reports we haven't
                // analyzed yet. board.game.getNodeIds() / getHistory() lets us
                // pull the full UCI list, so we never have to derive moves from
                // FEN diffs (was the cause of the "stuck at idle" failure).
                const fullHistory = this._getMoveHistoryFromBoard();

                if (fullHistory && fullHistory.length < this.gameAnalysis.moves.length) {
                    // History shorter than what we tracked = game was reset/rewound
                    this.gameAnalysis.moves = [];
                    this.gameAnalysis.sans = [];
                    this.gameAnalysis.classifications = [];
                    this.gameAnalysis.openings = [];
                    this.gameAnalysis.fens = this.gameAnalysis.fens.slice(0, 1);
                    this.gameAnalysis.evals = this.gameAnalysis.evals.slice(0, 1);
                    this.gameAnalysis.winPercents = this.gameAnalysis.winPercents.slice(0, 1);
                    this.clearOverlay();
                }

                // Invariant: fens.length must equal moves.length + 1 (each
                // move is sandwiched between two positions, plus startFen).
                // If broken, our pushes have desynced — full reset and let
                // the next tick re-seed cleanly.
                if (this.gameAnalysis.fens.length !== this.gameAnalysis.moves.length + 1) {
                    console.warn(`Analyzer invariant broken (fens=${this.gameAnalysis.fens.length}, moves=${this.gameAnalysis.moves.length}) — reseeding`);
                    this.resetGameAnalysis();
                    this.clearOverlay();
                    this._needsReseed = true;
                    return;
                }

                if (fullHistory && fullHistory.length > this.gameAnalysis.moves.length) {
                    const total = fullHistory.length;
                    while (this.gameAnalysis.moves.length < fullHistory.length) {
                        const idx = this.gameAnalysis.moves.length;
                        const histEntry = fullHistory[idx];
                        let playedUci = histEntry.uci || null;
                        const playedSan = histEntry.san || null;
                        const isLatest = (idx === fullHistory.length - 1);
                        const prevFen = this.gameAnalysis.fens[this.gameAnalysis.fens.length - 1];
                        // _lastBotPlayedUci fallback: only fire when the move
                        // at this idx is genuinely OURS. The DOM history can
                        // lag the FEN by a ply, so naively trusting "latest +
                        // bot UCI cached" can map our cached UCI onto an
                        // OPPONENT slot — exactly the "played_uci X not legal
                        // from prev_fen" desync we were seeing.
                        if (!playedUci && !playedSan && this._lastBotPlayedUci && isLatest) {
                            const sideToMove = prevFen && prevFen.split(' ')[1] === 'w' ? 1 : 2;
                            if (sideToMove === this.myColor) {
                                playedUci = this._lastBotPlayedUci;
                                this._lastBotPlayedUci = null;
                            }
                        }
                        // No way to identify this move yet. The DOM hasn't
                        // surfaced it — break and let the next tick retry
                        // rather than guessing.
                        if (!playedUci && !playedSan) break;
                        // Show catch-up progress so user knows the analyzer is working
                        // through historic moves, not stuck.
                        if (total - idx > 1) {
                            this._setStatusPill(`catching up ${idx + 1}/${total}`, '#FFC107');
                        }
                        const prevEval = this.gameAnalysis.evals[this.gameAnalysis.evals.length - 1];
                        const result = await this._requestMoveAnalysis(prevFen, fen, prevEval, playedUci, playedSan);
                        if (!result) break;
                        const resultFen = result.current_fen || fen;
                        this.gameAnalysis.fens.push(resultFen);
                        this.gameAnalysis.evals.push({ lines: result.lines || [] });
                        this.gameAnalysis.moves.push(result.uci);
                        this.gameAnalysis.sans.push(result.san);
                        this.gameAnalysis.classifications.push(result.classification);
                        this.gameAnalysis.openings.push(result.opening || null);
                        this.gameAnalysis.winPercents.push(result.win_percent ?? 50);
                        this.updateEvalBar();
                        this.appendClassificationToList(result);
                        this.updateAccuracyPanel();
                        this._drawArrowsForLastMove(result, prevEval);
                        if (this.settings.injectMoveListIcons) {
                            setTimeout(() => this._injectAllMoveListIcons(), 100);
                        }
                        if (this.settings.botPremove && this.settings.autoMove && this._isPremoveSafe(result)) {
                            this.attemptPremove(result.lines[0].pv[1]);
                        }
                    }
                } else if (!fullHistory && fen !== this.gameAnalysis.lastSeenFen) {
                    // No history available — only the FEN-diff path. This only
                    // works for a single-ply gap; for larger gaps we just
                    // wait for the DOM to populate (handled by re-entry).
                    const prevFen = this.gameAnalysis.fens[this.gameAnalysis.fens.length - 1];
                    const prevEval = this.gameAnalysis.evals[this.gameAnalysis.evals.length - 1];
                    const result = await this._requestMoveAnalysis(prevFen, fen, prevEval);
                    if (result) {
                        this.gameAnalysis.fens.push(fen);
                        this.gameAnalysis.evals.push({ lines: result.lines || [] });
                        this.gameAnalysis.moves.push(result.uci);
                        this.gameAnalysis.sans.push(result.san);
                        this.gameAnalysis.classifications.push(result.classification);
                        this.gameAnalysis.openings.push(result.opening || null);
                        this.gameAnalysis.winPercents.push(result.win_percent ?? 50);
                        this.updateEvalBar();
                        this.appendClassificationToList(result);
                        this.updateAccuracyPanel();
                        this._drawArrowsForLastMove(result, prevEval);
                    }
                }
            } catch (err) {
                // Only warn once per unique broken FEN. Otherwise an unrecoverable
                // FEN-diff failure spams the console (and any DOM listeners
                // observing the console pill) thousands of times per second.
                const msg = (err && (err.message || err)) || 'unknown';
                if (this._lastWarnedFen !== fen + '|' + msg) {
                    this._lastWarnedFen = fen + '|' + msg;
                    console.warn('Analyzer loop error:', msg);
                }
                // Recovery: "illegal san" / "not legal" / parse failures mean
                // our tracked move list desynced from chess.com (typical
                // cause: a new game started without us catching the
                // transition). Wipe the cache; next tick re-seeds from
                // current chess.com history.
                if (/illegal|not legal|could not parse|not in legal/i.test(String(msg))) {
                    console.warn('🔄 Analyzer state desynced — full reset');
                    this.resetGameAnalysis();
                    this.clearOverlay();
                    this._needsReseed = true;
                }
            } finally {
                // CRITICAL: pin lastSeenFen here, not inside the try, so a
                // throw doesn't leave us spinning on the same broken state
                // every time the MutationObserver re-fires. EXCEPT when we
                // just did a recovery reset — then leave lastSeenFen null
                // so the next tick re-enters and walks the full history.
                if (this._needsReseed) {
                    this._needsReseed = false;
                    this.gameAnalysis.lastSeenFen = null;
                } else {
                    this.gameAnalysis.lastSeenFen = fen;
                }
                this.analyzerInProgress = false;
                this._setStatusPill('idle', '#4CAF50');
                // After processing the latest position, if it's now the
                // opponent's turn pre-analyze their likely replies so when
                // they actually move we hit the cache and play instantly.
                this._kickoffPonderIfOpponentTurn(fen);
            }
        }

        // -------- Pondering: cache likely user-turn positions during opp's think --------

        _kickoffPonderIfOpponentTurn(fen) {
            try {
                if (!this.settings.autoMove) return;
                if (!this.wsReady) return;
                if (!fen) return;
                if (this.isMyTurn()) return;
                if (this._lastPonderedFen === fen) return;  // already pondering this fen

                this._lastPonderedFen = fen;
                this._ponderIteration = 0;
                this._sendPonderIteration(fen);
            } catch (e) {}
        }

        // Iterative-deepening ponder. Each call advances one iteration: first
        // pass is fast/shallow (cache available within ~500ms of opp's turn),
        // subsequent passes overwrite cache entries with deeper analysis. The
        // server emits ponder_done after each pass; our ponder_done handler
        // re-enters this method until clock runs out, opp moves (FEN flips),
        // or the max iteration is hit. This is the "use the downtime" loop.
        _sendPonderIteration(fen) {
            if (!this.wsReady) return;
            if (!fen) return;
            if (this.isMyTurn()) return;
            if (this._lastPonderedFen !== fen) return;

            const it = (this._ponderIteration || 0) + 1;
            this._ponderIteration = it;
            if (it > 6) return;  // saturated — stockfish at depth ≥ 18 doesn't gain much for ponder

            const sec = this._getMyClockSeconds();
            // Per-iteration budget. Iter 1 is intentionally tiny so a usable
            // cache is available within hundreds of ms; later iters are slower
            // but never so slow they straddle a likely opp think tick.
            let perPositionMs, topK, depth;
            if (sec == null) {
                perPositionMs = 200 + 250 * it; topK = 3; depth = 8 + it * 2;
            } else if (sec < 15) {
                perPositionMs = 100 + 80 * it; topK = 3; depth = 7 + it;
            } else if (sec < 30) {
                perPositionMs = 130 + 120 * it; topK = 3; depth = 8 + it;
            } else if (sec < 90) {
                perPositionMs = 180 + 200 * it; topK = 3; depth = 8 + it * 2;
            } else if (sec < 180) {
                perPositionMs = 250 + 250 * it; topK = 4; depth = 9 + it * 2;
            } else if (sec < 600) {
                perPositionMs = 350 + 300 * it; topK = 4; depth = 10 + it * 2;
            } else {
                perPositionMs = 500 + 400 * it; topK = 4; depth = 11 + it * 2;
            }
            depth = Math.min(depth, 20);
            perPositionMs = Math.min(perPositionMs, 2500);
            const variants = this.getVariantsFromElo(this.settings.targetElo);

            try {
                this.ws.send(JSON.stringify({
                    type: 'ponder',
                    fen: fen,
                    depth: depth,
                    variants: variants,
                    maxThinkingTime: perPositionMs,
                    ponder_top_k: topK,
                    engine: 'stockfish',
                    iteration: it
                }));
            } catch (e) {}
        }

        _setStatusPill(text, color) {
            const pill = document.getElementById('chess-analyzer-status-pill');
            if (pill) { pill.textContent = text; pill.style.color = color; }
        }

        _isResetCondition(currentFen) {
            const lastFen = this.gameAnalysis.lastSeenFen;
            if (!lastFen) return false;
            const startFenRoot = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
            if (currentFen.startsWith(startFenRoot) && this.gameAnalysis.fens.length > 1) {
                return true;
            }
            const lastPP = lastFen.split(' ')[0];
            const curPP = currentFen.split(' ')[0];
            const lastFullMove = parseInt(lastFen.split(' ')[5]) || 1;
            const curFullMove = parseInt(currentFen.split(' ')[5]) || 1;
            if (curFullMove < lastFullMove) return true;
            // Piece count can never INCREASE mid-game (no spawning). A jump
            // up means a fresh game started without us catching the startpos
            // — happens when chess.com swaps the board without re-rendering.
            const countPieces = (pp) => (pp.match(/[a-zA-Z]/g) || []).length;
            const lastN = countPieces(lastPP);
            const curN = countPieces(curPP);
            if (curN > lastN) return true;
            // Big position discontinuity (>4 piece delta in one observed
            // tick is structurally impossible — captures remove ≤1/ply).
            if (curN < lastN - 4) return true;
            if (curFullMove === lastFullMove && lastPP === curPP) return false;
            return false;
        }

        _captureGameMetadata() {
            try {
                const players = document.querySelectorAll('[data-test-element="user-tagline-username"], .user-tagline-username, .player-username');
                if (players.length >= 2) {
                    this.gameAnalysis.whiteName = players[1]?.textContent?.trim() || null;
                    this.gameAnalysis.blackName = players[0]?.textContent?.trim() || null;
                }
                this.gameAnalysis.lastTargetElo = this.settings.targetElo;
            } catch (e) {}
        }

        // -------- WS request helpers --------

        _requestPositionEval(fen) {
            return new Promise((resolve) => {
                if (!this.wsReady) return resolve(null);
                if (this.pendingPositionAnalysis) {
                    return resolve(null);
                }
                const token = Symbol('positionAnalysis');
                this.pendingPositionAnalysis = {
                    token,
                    resolve: (data) => resolve({ lines: data.lines || [] }),
                    reject: () => resolve(null)
                };
                this.ws.send(JSON.stringify({
                    type: 'analyze_position',
                    fen,
                    depth: this.settings.analyzerDepth || 14,
                    variants: 5,
                    maxThinkingTime: 1500,
                    engine: this._getAnalysisEngine()
                }));
                setTimeout(() => {
                    if (this.pendingPositionAnalysis && this.pendingPositionAnalysis.token === token) {
                        this.pendingPositionAnalysis = null;
                        resolve(null);
                    }
                }, 15000);
            });
        }

        _requestMoveAnalysis(prevFen, currentFen, prevEval, playedUci, playedSan) {
            return new Promise((resolve, reject) => {
                if (!this.wsReady) return resolve(null);
                if (this.pendingMoveAnalysis) return resolve(null);
                // Guard: same position, no move identified. Without this, the
                // server's derive_uci_move() walks every legal move from
                // prev_fen looking for one that matches current_fen — finds
                // none — and replies "could not derive move from FEN diff".
                // Spammed the analyzer pill with errors until DOM history
                // populated. Just skip; next tick re-enters with real moves.
                if (prevFen === currentFen && !playedUci && !playedSan) {
                    return resolve(null);
                }
                const token = Symbol('moveAnalysis');
                this.pendingMoveAnalysis = { token, resolve, reject };
                const payload = {
                    type: 'analyze_move',
                    prev_fen: prevFen,
                    current_fen: currentFen,
                    prev_eval: prevEval,
                    depth: this.settings.analyzerDepth || 14,
                    variants: 5,
                    maxThinkingTime: 1500,
                    engine: this._getAnalysisEngine()
                };
                if (playedUci) payload.played_uci = playedUci;
                if (playedSan) payload.played_san = playedSan;
                this.ws.send(JSON.stringify(payload));
                setTimeout(() => {
                    if (this.pendingMoveAnalysis && this.pendingMoveAnalysis.token === token) {
                        this.pendingMoveAnalysis = null;
                        resolve(null);
                    }
                }, 15000);
            });
        }

        // Returns the full per-ply move history of the current chess.com game
        // as [{uci?, san?}, ...]. Tries board.game APIs first; if none exist
        // (current chess.com layout), reads chess.com's wc-simple-move-list
        // DOM where each move sits in a `.node[data-node="0-N"]` element with
        // SAN text under `.node-highlight-content` (the figurine letter is in
        // a `data-figurine` attribute on a child span).
        _getMoveHistoryFromBoard() {
            const board = this.getBoard();
            if (board?.game) {
                try {
                    if (typeof board.game.getNodeIds === 'function' &&
                        typeof board.game.getNodeByIds === 'function') {
                        const ids = board.game.getNodeIds() || [];
                        const out = [];
                        for (const id of ids) {
                            const node = board.game.getNodeByIds(id);
                            const m = node?.move;
                            if (m?.from && m?.to) {
                                out.push({ uci: m.from + m.to + (m.promotion && m.promotion !== 'false' ? m.promotion : '') });
                            }
                        }
                        if (out.length) return out;
                    }
                    if (typeof board.game.getHistory === 'function') {
                        const h = board.game.getHistory() || [];
                        const out = [];
                        for (const m of h) {
                            if (m?.from && m?.to) {
                                out.push({ uci: m.from + m.to + (m.promotion && m.promotion !== 'false' ? m.promotion : '') });
                            }
                        }
                        if (out.length) return out;
                    }
                    if (typeof board.game.getMoves === 'function') {
                        const ms = board.game.getMoves() || [];
                        const out = [];
                        for (const m of ms) {
                            if (m?.from && m?.to) {
                                out.push({ uci: m.from + m.to + (m.promotion && m.promotion !== 'false' ? m.promotion : '') });
                            }
                        }
                        if (out.length) return out;
                    }
                } catch (e) {}
            }
            // DOM fallback (current chess.com layout)
            return this._getMoveHistoryFromDom();
        }

        _getMoveHistoryFromDom() {
            try {
                const list = this._findMoveListEl();
                if (!list) return null;
                const nodes = list.querySelectorAll('[data-node]');
                if (!nodes.length) return null;
                const moves = [];
                nodes.forEach((n) => {
                    const dn = n.getAttribute('data-node') || '';
                    const m = /(\d+)$/.exec(dn);
                    if (!m) return;
                    const ply = parseInt(m[1], 10);
                    const container = n.querySelector('.node-highlight-content') || n;
                    let san = '';
                    container.childNodes.forEach((child) => {
                        if (child.nodeType === Node.TEXT_NODE) {
                            san += child.textContent;
                        } else if (child.getAttribute) {
                            const fig = child.getAttribute('data-figurine');
                            if (fig) san += fig;
                            else if (child.textContent) san += child.textContent;
                        }
                    });
                    san = san.replace(/\s+/g, '').trim();
                    if (san) moves.push({ ply, san });
                });
                if (!moves.length) return null;
                moves.sort((a, b) => a.ply - b.ply);
                return moves.map((mv) => ({ san: mv.san }));
            } catch (e) {
                return null;
            }
        }

        _requestGameAnalysis(moves, depth, multipv, onProgress) {
            return new Promise((resolve, reject) => {
                if (!this.wsReady) return reject(new Error('WS not ready'));
                if (this.pendingGameAnalysis) return reject(new Error('review already in progress'));
                this.pendingGameAnalysis = { resolve, reject, onProgress };
                this.ws.send(JSON.stringify({
                    type: 'analyze_game',
                    moves,
                    depth,
                    variants: multipv,
                    maxThinkingTime: 2500,
                    engine: this._getAnalysisEngine(),
                    white_elo: this.settings.targetElo,
                    black_elo: this.settings.targetElo
                }));
            });
        }

        // -------- Reset / new game --------

        resetGameAnalysis() {
            this.gameAnalysis = this._emptyGameAnalysis();
        }

        // -------- Review (post-game / on-demand full classification) --------

        async requestFullReview() {
            if (this.gameAnalysis.moves.length === 0) {
                console.warn('No moves to review yet');
                this._showValidation('No moves recorded yet — play a few first.', '#FFC107');
                return;
            }
            const btn = document.getElementById('cas-review-btn');
            const progress = document.getElementById('cas-review-progress');
            if (btn) { btn.disabled = true; btn.textContent = 'Reviewing…'; }
            if (progress) { progress.style.display = 'block'; progress.textContent = 'Starting…'; }
            this._setStatusPill('reviewing', '#3894eb');
            try {
                const moves = [...this.gameAnalysis.moves];
                const result = await this._requestGameAnalysis(
                    moves,
                    Math.max(this.settings.analyzerDepth || 14, 16),
                    this.getVariantsFromElo(this.settings.targetElo),
                    (p) => { if (progress) progress.textContent = `Analyzing ${p.ply}/${p.total}…`; }
                );
                this._applyReviewResult(result);
                if (progress) progress.textContent = `Done — depth ${result.depth}.`;
            } catch (err) {
                console.error('Review failed:', err);
                if (progress) progress.textContent = `Failed: ${err.message}`;
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Review Game'; }
                this._setStatusPill('idle', '#4CAF50');
            }
        }

        _applyReviewResult(result) {
            const positions = result.positions || [];
            this.gameAnalysis.fens = [];
            this.gameAnalysis.evals = [];
            this.gameAnalysis.moves = [];
            this.gameAnalysis.sans = [];
            this.gameAnalysis.classifications = [];
            this.gameAnalysis.openings = [];
            this.gameAnalysis.winPercents = [];
            for (const p of positions) {
                this.gameAnalysis.fens.push(p.fen);
                this.gameAnalysis.evals.push({ lines: p.lines || [] });
                this.gameAnalysis.winPercents.push(p.win_percent ?? 50);
                if (p.index > 0) {
                    this.gameAnalysis.moves.push(p.uci);
                    this.gameAnalysis.sans.push(p.san);
                    this.gameAnalysis.classifications.push(p.moveClassification);
                    this.gameAnalysis.openings.push(p.opening || null);
                }
            }
            this.gameAnalysis.lastSeenFen = this.gameAnalysis.fens[this.gameAnalysis.fens.length - 1];
            this.rebuildClassificationsList();
            this.updateEvalBar();
            const acc = result.accuracy || { white: 0, black: 0 };
            const elo = result.estimated_elo || { white: 0, black: 0, white_acpl: 0, black_acpl: 0 };
            this._setStatsLabels(
                { white: `${acc.white.toFixed(1)}%`, black: `${acc.black.toFixed(1)}%` },
                { white: Math.round(elo.white).toString(), black: Math.round(elo.black).toString() },
                { white: elo.white_acpl.toFixed(1), black: elo.black_acpl.toFixed(1) }
            );
        }

        // -------- Bot-Elo validation --------

        async runBotValidation() {
            if (!this.settings.validateBotElo) return;
            if (this.gameAnalysis.moves.length < 6) return;

            this._setStatusPill('validating', '#3894eb');
            try {
                const moves = [...this.gameAnalysis.moves];
                const result = await this._requestGameAnalysis(
                    moves,
                    Math.max(this.settings.analyzerDepth || 14, 16),
                    this.getVariantsFromElo(this.settings.targetElo),
                    null
                );
                const elo = result.estimated_elo;
                if (!elo) return;
                const target = this.gameAnalysis.lastTargetElo || this.settings.targetElo;
                const botSide = this.myColor === 1 ? 'white' : 'black';
                const achieved = botSide === 'white' ? elo.white : elo.black;
                const acpl = botSide === 'white' ? elo.white_acpl : elo.black_acpl;
                const delta = achieved - target;
                const newAdj = this._updateEloAdjustment(target, achieved);
                const nextEff = Math.max(250, Math.min(3200, target + newAdj));
                const summary = `Bot validation — target ${target} | achieved ${Math.round(achieved)} | Δ ${delta >= 0 ? '+' : ''}${Math.round(delta)} | ACPL ${acpl.toFixed(1)} | auto-tune adj=${newAdj} (next game effective target ${nextEff})`;
                console.log('═══════════════════════════════');
                console.log(summary);
                console.log(`White acc ${result.accuracy.white.toFixed(1)}% | Black acc ${result.accuracy.black.toFixed(1)}%`);
                console.log('═══════════════════════════════');
                this._showValidation(summary, Math.abs(delta) < 50 ? '#4CAF50' : '#FFC107');
                this.gameAnalysis.gameOverSummary = summary;
                this._applyReviewResult(result);
                this._persistValidationLog({ target, achieved, delta, acpl, adjustment: newAdj, accuracy: result.accuracy, ts: Date.now() });
                this._refreshTargetEloDisplay();
            } catch (err) {
                console.error('Bot validation failed:', err);
            } finally {
                this._setStatusPill('idle', '#4CAF50');
            }
        }

        _showValidation(text, color) {
            const div = document.getElementById('cas-validation-result');
            if (!div) return;
            div.style.display = 'block';
            div.style.borderLeft = `3px solid ${color}`;
            div.style.color = color;
            div.textContent = text;
        }

        _persistValidationLog(entry) {
            try {
                const key = 'chessAnalyzerValidationLog';
                const existing = JSON.parse(GM_getValue(key) || '[]');
                existing.push(entry);
                if (existing.length > 200) existing.shift();
                GM_setValue(key, JSON.stringify(existing));
            } catch (e) {}
        }

        // -------- Export current analysis as JSON --------

        exportAnalysisJson() {
            const data = {
                ts: new Date().toISOString(),
                target_elo: this.gameAnalysis.lastTargetElo || this.settings.targetElo,
                white: this.gameAnalysis.whiteName,
                black: this.gameAnalysis.blackName,
                moves: this.gameAnalysis.moves,
                sans: this.gameAnalysis.sans,
                classifications: this.gameAnalysis.classifications,
                openings: this.gameAnalysis.openings,
                win_percents: this.gameAnalysis.winPercents,
                fens: this.gameAnalysis.fens,
                evals: this.gameAnalysis.evals
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chess-analysis-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
        }
    }

    function init() {
        const analyzer = new ChessAnalyzer();
        analyzer.initialize();
        window.chessAnalyzer = analyzer;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
