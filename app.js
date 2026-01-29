"use strict";

// --- Settings Management ---
const DEFAULTS = {
    janusServer: "https://www.vas.com.tw/janus",
    userID: "user",
    sipRegistrar: "",
    sipIdentity: "",
    authUser: "",
    sipPassword: "",
    displayName: "",
    callee: "",
    turnAuthApi: "https://www.vas.com.tw/api/get-turn-credentials",
    sipProxyApi: "https://www.vas.com.tw/api/sip-register",
    turnUrls: '["turn:www.vas.com.tw:3478?transport=udp", "turn:www.vas.com.tw:3478?transport=tcp"]',
    forceTurn: false
};

const Settings = {
    load() {
        const saved = localStorage.getItem("janus_sip_settings");
        let parsed = {};
        try {
            parsed = saved ? JSON.parse(saved) : {};
        } catch (e) {
            console.warn("Error parsing saved settings", e);
        }

        // Merge defaults with saved values
        let settings = { ...DEFAULTS, ...parsed };

        // 確保欄位不為空 否則用預設
        Object.keys(DEFAULTS).forEach(key => {
            if ((settings[key] === undefined || settings[key] === "") && DEFAULTS[key] !== "") {
                settings[key] = DEFAULTS[key];
            }
        });
        return settings;
    },
    save(data) {
        localStorage.setItem("janus_sip_settings", JSON.stringify(data));
    }
};

// --- UI Logic ---
const UI = {
    statusBadge: document.getElementById("status"),
    callBtn: document.getElementById("call-btn"),
    iconCall: document.getElementById("icon-call"),
    iconHangup: document.getElementById("icon-hangup"),
    remoteIdentity: document.getElementById("remote-identity"),
    modal: document.getElementById("settings-modal"),
    form: document.getElementById("settings-form"),

    updateStatus(text, className = "") {
        this.statusBadge.innerText = text;
        this.statusBadge.className = "status-badge " + className;
        console.log(`[Status] ${text}`);
    },

    setCallState(isInCall) {
        if (isInCall) {
            this.callBtn.classList.add("hanging-up");
            this.iconCall.style.display = "none";
            this.iconHangup.style.display = "block";
        } else {
            this.callBtn.classList.remove("hanging-up");
            this.iconCall.style.display = "block";
            this.iconHangup.style.display = "none";
            this.remoteIdentity.innerText = "";
        }
        // DTMF UI handling
        const dtmfPad = document.getElementById("dtmf-pad");
        if (dtmfPad) {
            dtmfPad.style.display = isInCall ? "grid" : "none";
        }
    },

    showModal() { this.modal.style.display = "flex"; },
    hideModal() { this.modal.style.display = "none"; },

    populateForm(data) {
        Object.keys(data).forEach(key => {
            const input = document.getElementById(`cfg-${key}`);
            if (input) {
                if (input.type === "checkbox") input.checked = data[key];
                else input.value = data[key];
            }
        });
    },

    getFormData() {
        const data = {};
        Object.keys(DEFAULTS).forEach(key => {
            const input = document.getElementById(`cfg-${key}`);
            if (input) {
                if (input.type === "checkbox") data[key] = input.checked;
                else data[key] = input.value;
            }
        });
        return data;
    }
};

// --- DTMF Tone Generator (Web Audio API) ---
const DTMFToneGenerator = {
    context: null,
    frequencies: {
        "1": [697, 1209], "2": [697, 1336], "3": [697, 1477], "A": [697, 1633],
        "4": [770, 1209], "5": [770, 1336], "6": [770, 1477], "B": [770, 1633],
        "7": [852, 1209], "8": [852, 1336], "9": [852, 1477], "C": [852, 1633],
        "*": [941, 1209], "0": [941, 1336], "#": [941, 1477], "D": [941, 1633]
    },

    init() {
        if (!this.context) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            this.context = new AudioContext();
        }
        // Resume context if suspended (browser policy)
        if (this.context.state === 'suspended') {
            this.context.resume().then(() => console.log("DTMF AudioContext resumed"));
        }
    },

    play(digit) {
        if (!this.frequencies[digit]) {
            console.warn("Unknown DTMF digit:", digit);
            return;
        }

        try {
            this.init();
            console.log("Playing DTMF Tone for:", digit);

            const [lowFreq, highFreq] = this.frequencies[digit];
            const ctx = this.context;
            const currentTime = ctx.currentTime;
            const duration = 0.2; // 200ms

            // Oscillator 1 (Low Frequency)
            const osc1 = ctx.createOscillator();
            osc1.frequency.value = lowFreq;
            osc1.type = "sine";

            // Oscillator 2 (High Frequency)
            const osc2 = ctx.createOscillator();
            osc2.frequency.value = highFreq;
            osc2.type = "sine";

            // Gain Node (Volume Control)
            const gainNode = ctx.createGain();
            // Start at 0 to avoid pop
            gainNode.gain.setValueAtTime(0, currentTime);
            // Attack to 0.3 (louder)
            gainNode.gain.linearRampToValueAtTime(0.3, currentTime + 0.01);
            // Sustain
            gainNode.gain.setValueAtTime(0.3, currentTime + duration - 0.01);
            // Release to 0
            gainNode.gain.linearRampToValueAtTime(0, currentTime + duration);

            // Connect graph
            osc1.connect(gainNode);
            osc2.connect(gainNode);
            gainNode.connect(ctx.destination);

            // Start and Stop
            osc1.start(currentTime);
            osc2.start(currentTime);
            osc1.stop(currentTime + duration);
            osc2.stop(currentTime + duration);
        } catch (e) {
            console.error("Error generating DTMF tone:", e);
        }
    }
};

// --- Janus SIP Class ---
class JanusSIP {
    constructor() {
        this.janus = null;
        this.sipHandle = null;
        this.opaqueId = "siptest-" + Janus.randomString(12);
        this.settings = Settings.load();
        this.isRegistered = false;
        this.isCalling = false;
        this.localStream = null;
        this.backendCallee = null;
        this.sipIdentity = null;
        this.sipUsername = null;
        this.sipDisplayName = null;
    }

    async getTurnCredentials() {
        if (!this.settings.turnAuthApi) return null;
        try {
            console.log("Fetching TURN credentials...");
            const response = await fetch(this.settings.turnAuthApi);
            if (!response.ok) throw new Error("Auth API failed");
            return await response.json();
        } catch (e) {
            console.error("Failed to fetch TURN credentials:", e);
            return null;
        }
    }

    async init() {
        return new Promise((resolve, reject) => {
            Janus.init({
                debug: ["log", "warn", "error"],
                callback: () => resolve()
            });
        });
    }

    async start() {
        try {
            if (this.isCalling) {
                console.log("Call in progress, hanging up...");
                this.hangup();
                return;
            }

            this.isCalling = true;
            UI.setCallState(true);
            UI.updateStatus("正在獲取憑證...", "calling");

            // Safari Autoplay
            const audio = document.getElementById("remote-audio");
            if (audio) {
                audio.muted = false;
                audio.setAttribute('playsinline', 'true');

                if (!audio.srcObject) {
                    const originalSrc = audio.src;
                    audio.src = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA== ";
                    audio.play().then(() => {
                        console.log("Audio system unlocked for Safari");
                        audio.src = originalSrc;

                        if (navigator.audioSession) {
                            navigator.audioSession.type = 'play-and-record';
                            console.log("Safari audioSession set to play-and-record");
                        }
                    }).catch(e => console.warn("Audio unlock failed:", e));
                }
            }

            const turnCreds = await this.getTurnCredentials();

            let iceServers = [];
            try {
                const configuredUrls = JSON.parse(this.settings.turnUrls || "[]");

                if (turnCreds && configuredUrls.length > 0) {
                    iceServers.push({
                        urls: configuredUrls,
                        username: turnCreds.username,
                        credential: turnCreds.credential
                    });
                    console.log("Using dynamic TURN credentials for:", configuredUrls);
                } else if (turnCreds) {
                    iceServers.push({
                        urls: turnCreds.urls,
                        username: turnCreds.username,
                        credential: turnCreds.credential
                    });
                    console.log("Using TURN from API:", turnCreds.urls);
                } else if (configuredUrls.length > 0) {
                    iceServers.push({ urls: configuredUrls });
                }
            } catch (e) {
                console.error("Error parsing turnUrls, falling back to basic setup", e);
            }

            iceServers.push({ urls: "stun:stun.l.google.com:19302" });

            console.log("Final ICE Servers:", JSON.stringify(iceServers, null, 2));
            console.log("Connecting to Janus Server:", this.settings.janusServer);
            if (!this.settings.janusServer) {
                UI.updateStatus("伺服器地址無效", "danger");
                alert("錯誤：Janus Server 地址不能為空，請在設定中填寫。");
                this.cleanup();
                return;
            }

            this.janus = new Janus({
                server: this.settings.janusServer,
                iceServers: iceServers,
                iceTransportPolicy: this.settings.forceTurn ? "relay" : undefined,
                success: () => {
                    UI.updateStatus("已連線 Janus", "registered");
                    this.attachPlugin();
                },
                error: (error) => {
                    UI.updateStatus("Janus 錯誤", "danger");
                    alert(error);
                    this.cleanup();
                },
                destroyed: () => {
                    console.log("Janus destroyed");
                    this.cleanup();
                }
            });
        } catch (e) {
            console.error("Critical error during start:", e);
            this.cleanup();
        }
    }

    attachPlugin() {
        this.janus.attach({
            plugin: "janus.plugin.sip",
            opaqueId: this.opaqueId,
            success: (handle) => {
                this.sipHandle = handle;
                UI.updateStatus("插件已掛載", "registered");
                this.proxyRegister();
            },
            error: (error) => {
                UI.updateStatus("插件錯誤", "danger");
                alert(error);
            },
            iceState: (state) => {
                console.log(`%c[ICE State] ${state}`, "color: blue; font-weight: bold");
                if (state === "failed") {
                    UI.updateStatus("ICE 連線失敗", "danger");
                    this.cleanup(true);
                } else if (state === "disconnected") {
                    console.warn("ICE disconnected, waiting for reconnection...");
                }
            },
            onmessage: (msg, jsep) => {
                this.handleMessage(msg, jsep);
            },
            onlocalstream: (stream) => {
                console.log("Got local stream");
                this.localStream = stream;

                if (navigator.audioSession) {
                    navigator.audioSession.type = 'play-and-record';
                    console.log("Local stream acquired, audioSession = play-and-record");
                }
            },
            onremotestream: (stream) => {
                console.log("Got remote stream");
                const audio = document.getElementById("remote-audio");

                if (audio.srcObject !== stream) {
                    audio.muted = false;
                    Janus.attachMediaStream(audio, stream);
                    setTimeout(() => {
                        audio.play().then(() => {
                            console.log("Remote audio playing successfully");
                            UI.updateStatus(this.isRegistered ? "通話中" : "已接聽", "incall");
                        }).catch(e => {
                            if (e.name !== "AbortError") {
                                console.error("Error playing remote audio:", e);
                            }
                        });
                    }, 150);
                }
            },
            oncleanup: () => {
                console.log("Cleanup notification");
                this.cleanup();
            }
        });
    }

    async proxyRegister() {
        UI.updateStatus("正在請求代理註冊...", "calling");
        try {
            const body = {
                userID: this.settings.userID,
                sip_server: this.settings.sipRegistrar.replace("sip:", ""),
                sessionID: this.janus.getSessionId(),
                handleID: this.sipHandle.getId()
            };

            console.log("Requesting Proxy Register for UID:", body.userID, "Session:", body.sessionID, "Handle:", body.handleID);
            const response = await fetch(this.settings.sipProxyApi, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await response.json();
            if (!data.success) throw new Error(data.error || "代理註冊失敗");

            this.backendCallee = data.callee;
            this.sipIdentity = data.sip_identity;
            this.sipUsername = data.sip_username;
            this.sipDisplayName = data.sip_displayname;

            console.log("代理註冊成功，撥號員:", this.sipUsername, "顯示名:", this.sipDisplayName);
        } catch (e) {
            console.error("Proxy Register Error:", e);
            UI.updateStatus("代理註冊失敗", "danger");
            this.cleanup();
        }
    }

    register() {
        const body = {
            request: "register",
            username: this.settings.sipIdentity,
            authuser: this.settings.authUser,
            secret: this.settings.sipPassword,
            display_name: this.settings.displayName,
            proxy: this.settings.sipRegistrar
        };
        console.log("Registering SIP:", body.username);
        this.sipHandle.send({ message: body });
    }

    handleMessage(msg, jsep) {
        const { result, error } = msg;
        if (error) {
            UI.updateStatus("SIP 錯誤: " + error, "danger");
            this.cleanup();
            return;
        }

        if (result && result.event) {
            console.log(`[SIP Event] ${result.event}`);
            switch (result.event) {
                case "registered":
                    this.isRegistered = true;
                    UI.updateStatus("已註冊 SIP", "registered");
                    this.makeCall();
                    break;
                case "calling":
                    UI.updateStatus("撥號中...", "calling");
                    break;
                case "progress":
                case "accepted":
                    const statusText = result.event === "progress" ? "早媒體 (Progress)" : "通話中";
                    UI.updateStatus(statusText, "incall");
                    if (jsep) {
                        console.log("Handling JSEP for " + result.event);
                        this.sipHandle.handleRemoteJsep({ jsep, error: () => this.hangup() });
                    }
                    break;
                case "unregistered":
                case "hangup":
                    UI.updateStatus("已掛斷: " + (result.reason || "正常"), "");
                    this.cleanup();
                    break;
            }
        }
    }

    makeCall() {
        const target = this.backendCallee || this.settings.callee;
        if (!target) {
            alert("錯誤：未指定撥號對象");
            this.hangup();
            return;
        }

        let domain = "";
        if (this.sipIdentity && this.sipIdentity.includes("@")) {
            domain = this.sipIdentity.split("@")[1];
        } else {
            domain = this.settings.sipRegistrar.replace("sip:", "");
        }

        const displayName = this.sipDisplayName || this.sipUsername || "Web";
        const formattedDisplayName = `"${displayName}"sip:${domain}`;

        this.sipHandle.createOffer({
            media: { audio: true, video: false },
            success: (jsep) => {
                const body = {
                    request: "call",
                    uri: target,
                    display_name: formattedDisplayName
                };
                console.log("撥號至:", target, "顯示名稱:", formattedDisplayName);
                this.sipHandle.send({ message: body, jsep: jsep });
            },
            error: (error) => {
                alert("WebRTC offer error: " + error.message);
                this.hangup();
            }
        });
    }

    hangup() {
        UI.updateStatus("已掛斷", "");
        if (this.sipHandle) {
            try {
                this.sipHandle.send({ message: { request: "hangup" } });
            } catch (e) {
                console.warn("Hangup send failed (session might be gone):", e);
            }
        }
        this.cleanup();
    }

    sendDTMF(digit) {
        if (!this.sipHandle || !this.isCalling) return;
        console.log("Sending DTMF:", digit);
        this.sipHandle.dtmf({
            dtmf: {
                tones: digit
            }
        });
    }

    cleanup(isSoft = false) {
        if (!this.janus && !this.isCalling) return;

        if (this.localStream) {
            console.log("Stopping local stream tracks");
            Janus.stopAllTracks(this.localStream);
            this.localStream = null;
        }

        console.log(`Cleaning up (soft: ${isSoft})`);
        this.isCalling = false;
        this.isRegistered = false;
        UI.setCallState(false);

        if (this.janus && !isSoft) {
            const j = this.janus;
            this.janus = null;
            j.destroy();
        }
    }
}

// --- Initialization ---
const app = new JanusSIP();

document.addEventListener("DOMContentLoaded", async () => {
    await app.init();
    UI.populateForm(app.settings);

    document.getElementById("open-settings").onclick = () => UI.showModal();
    document.getElementById("close-settings").onclick = () => UI.hideModal();
    UI.callBtn.onclick = () => app.start();

    UI.form.onsubmit = (e) => {
        e.preventDefault();
        const inputData = UI.getFormData();

        const mergedData = { ...app.settings, ...inputData };
        Settings.save(mergedData);

        app.settings = Settings.load();
        UI.hideModal();
        UI.updateStatus("設定已儲存");
    };

    // DTMF Keypad listeners
    const dtmfButtons = document.querySelectorAll(".dtmf-btn");
    dtmfButtons.forEach(btn => {
        btn.onclick = () => {
            const digit = btn.getAttribute("data-digit");
            // Play local sound
            DTMFToneGenerator.play(digit);
            // Send DTMF via SIP
            app.sendDTMF(digit);
        };
    });
});
