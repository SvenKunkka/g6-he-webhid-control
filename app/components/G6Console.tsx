"use client";

import { useCallback, useMemo, useRef, useState } from "react";

const VID = 0x3434;
const PID = 0xd086;
const POLLING = [125, 500, 1000, 2000, 4000, 8000];
const DEFAULT_DPI = [400, 800, 1600, 3200, 5000];
const BUTTONS = [
  { index: 0, label: "左键" },
  { index: 2, label: "右键" },
  { index: 1, label: "中键" },
  { index: 3, label: "后退" },
  { index: 4, label: "前进" },
];

type DeviceState = "idle" | "connecting" | "online" | "stalled" | "unsupported";
type LogItem = { at: string; level: "ok" | "warn" | "error" | "info"; text: string };
type Mapping = Record<number, string>;
type HidCollection = { usagePage?: number; usage?: number };
type HidDeviceLike = {
  opened: boolean;
  productName: string;
  vendorId: number;
  productId: number;
  collections?: HidCollection[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
};
type HidNavigator = Navigator & {
  hid?: {
    requestDevice(options: { filters: Array<{ vendorId: number; productId: number }> }): Promise<HidDeviceLike[]>;
    getDevices(): Promise<HidDeviceLike[]>;
  };
};

function hex(value: number, size = 4) {
  return `0x${value.toString(16).toUpperCase().padStart(size, "0")}`;
}

function now() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join(" ");
}

function normalizeFeature(view: DataView, reportId: number) {
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return raw[0] === reportId ? raw.slice(1) : raw;
}

function littleEndian16(values: number[]) {
  return values.flatMap((value) => [value & 0xff, (value >> 8) & 0xff]);
}

const mappingValue: Record<string, number | null> = {
  "左键": 0x010000,
  "右键": 0x020000,
  "中键": 0x040000,
  "后退": 0x100000,
  "前进": 0x080000,
  "禁用": null,
};

function decodeBasic(bytes: Uint8Array) {
  const value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const found = Object.entries(mappingValue).find(([, code]) => code === value);
  return found?.[0] ?? `未知 ${hex(value, 6)}`;
}

export function G6Console() {
  const [state, setState] = useState<DeviceState>("idle");
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [activeDpi, setActiveDpi] = useState(2);
  const [polling, setPolling] = useState(1000);
  const [fps20k, setFps20k] = useState(false);
  const [lod, setLod] = useState(3);
  const [firmware, setFirmware] = useState("未读取");
  const [protocol, setProtocol] = useState("等待握手");
  const [battery, setBattery] = useState<number | null>(null);
  const [mappings, setMappings] = useState<Mapping>({
    0: "左键",
    2: "右键",
    1: "中键",
    3: "后退",
    4: "前进",
  });
  const [logs, setLogs] = useState<LogItem[]>([
    { at: "BOOT", level: "info", text: "控制台就绪；尚未访问任何 HID 设备。" },
  ]);
  const [busy, setBusy] = useState(false);
  const [hasDevice, setHasDevice] = useState(false);
  const deviceRef = useRef<HidDeviceLike | null>(null);

  const addLog = useCallback((text: string, level: LogItem["level"] = "info") => {
    setLogs((items) => [{ at: now(), level, text }, ...items].slice(0, 18));
  }, []);

  const transact = useCallback(
    async (reportId: number, payload: Uint8Array, expected?: number) => {
      const device = deviceRef.current;
      if (!device?.opened) throw new Error("设备未连接");
      await device.sendFeatureReport(reportId, payload);
      const response = normalizeFeature(await device.receiveFeatureReport(reportId), reportId);
      if (!response.length) throw new Error("固件返回空报告");
      if (expected !== undefined && response[0] !== expected) {
        throw new Error(`响应异常：期望 ${hex(expected, 2)}，收到 ${hex(response[0], 2)}`);
      }
      return response;
    },
    [],
  );

  const readDevice = useCallback(async () => {
    const baseRequest = new Uint8Array(20);
    baseRequest[0] = 7;
    const base = await transact(0x51, baseRequest, 7);

    const currentDpi = base[2] & 0x0f;
    const currentPolling = (base[2] >> 4) & 0x0f;
    const values = Array.from({ length: 5 }, (_, i) => base[5 + i * 2] | (base[6 + i * 2] << 8));
    const cleanValues = values.every((value) => value > 0) ? values : DEFAULT_DPI;

    setActiveDpi(Math.min(currentDpi, 4));
    setDpi(cleanValues);
    setPolling([125, 500, 1000][currentPolling] ?? 1000);
    setLod(base[15] & 0x03);

    const infoRequest = new Uint8Array(20);
    infoRequest[0] = 6;
    const info = await transact(0x51, infoRequest, 6);
    const version = `${info[8]}.${(info[7] >> 4) & 0x0f}.${info[7] & 0x0f}`;
    setFirmware(version);
    setBattery(info[10]);
    setProtocol("Keychron 1K Feature / 0x51");
    setFps20k(false);

    addLog(`握手成功：FW ${version}，DPI ${cleanValues[currentDpi] ?? "?"}，${[125, 500, 1000][currentPolling] ?? "?"} Hz。`, "ok");
    return { base, info };
  }, [addLog, transact]);

  const readMappings = useCallback(async () => {
    const next: Mapping = {};
    for (const button of BUTTONS) {
      const request = new Uint8Array(64);
      request[0] = 98;
      request[1] = button.index;
      const response = await transact(0x52, request, 98);
      if (response[3] === 1) next[button.index] = decodeBasic(response.slice(4, 7));
      else if (response[3] === 9) next[button.index] = "禁用";
      else next[button.index] = `功能类型 ${response[3]}`;
    }
    setMappings((current) => ({ ...current, ...next }));
    addLog("已读取 5 个主按键映射。", "ok");
  }, [addLog, transact]);

  const connect = useCallback(async () => {
    const hid = (navigator as HidNavigator).hid;
    if (!hid) return setState("unsupported");
    setBusy(true);
    setState("connecting");
    try {
      const granted = (await hid.getDevices()).filter((d) => d.vendorId === VID && d.productId === PID);
      const devices = granted.length
        ? granted
        : await hid.requestDevice({ filters: [{ vendorId: VID, productId: PID }] });
      if (devices.length !== 1) throw new Error(`需要唯一一只 G6 HE，当前选择 ${devices.length} 个`);
      const device = devices[0];
      const configCollection = device.collections?.some((item) => item.usagePage === 0xffc1);
      if (!configCollection) throw new Error("未发现 0xFFC1 配置接口");
      if (!device.opened) await device.open();
      deviceRef.current = device;
      setHasDevice(true);
      await readDevice();
      setState("online");
      try {
        await readMappings();
      } catch (error) {
        addLog(`按键读取失败：${error instanceof Error ? error.message : String(error)}`, "warn");
      }
    } catch (error) {
      setState("stalled");
      addLog(`连接/握手失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, readDevice, readMappings]);

  const reconnect = useCallback(async () => {
    setBusy(true);
    addLog("执行可逆重连：关闭并重新打开 WebHID 会话。");
    try {
      const device = deviceRef.current;
      if (!device) throw new Error("请先连接设备");
      if (device.opened) await device.close();
      await device.open();
      await readDevice();
      setState("online");
      addLog("重连完成，配置通道有响应。", "ok");
    } catch (error) {
      setState("stalled");
      addLog(`重连无效：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, readDevice]);

  const applyDpi = useCallback(async () => {
    setBusy(true);
    try {
      const payload = new Uint8Array(20);
      payload[0] = 64;
      payload[1] = activeDpi;
      payload[2] = activeDpi;
      payload[3] = activeDpi;
      littleEndian16(dpi).forEach((value, index) => (payload[4 + index] = value));
      payload[14] = 5;
      const response = await transact(0x51, payload);
      addLog(`DPI 已写入：${dpi.join(" / ")}；响应 ${bytesToHex(response.slice(0, 4))}。`, "ok");
      await readDevice();
    } catch (error) {
      addLog(`DPI 写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [activeDpi, addLog, dpi, readDevice, transact]);

  const applyPolling = useCallback(async () => {
    setBusy(true);
    try {
      const level = [125, 500, 1000].indexOf(polling);
      if (level < 0) throw new Error("当前固件 1K 协议仅暴露 125 / 500 / 1000 Hz，已阻止越界写入");
      const payload = new Uint8Array(20);
      payload[0] = 65;
      payload[1] = level;
      payload[2] = level;
      payload[3] = 0;
      payload[4] = 1;
      payload[5] = 2;
      const response = await transact(0x51, payload);
      addLog(`回报率已写入：${polling} Hz；响应 ${bytesToHex(response.slice(0, 4))}。`, "ok");
      await readDevice();
    } catch (error) {
      addLog(`回报率写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, polling, readDevice, transact]);

  const applyMapping = useCallback(
    async (index: number, value: string) => {
      setBusy(true);
      try {
        const payload = new Uint8Array(64);
        payload[0] = 82;
        payload[1] = index;
        payload[3] = value === "禁用" ? 9 : 1;
        const code = mappingValue[value];
        if (code !== null && code !== undefined) {
          payload[4] = (code >> 16) & 0xff;
          payload[5] = (code >> 8) & 0xff;
          payload[6] = code & 0xff;
        }
        await transact(0x52, payload);
        setMappings((items) => ({ ...items, [index]: value }));
        addLog(`按键 ${index} 已改为“${value}”。`, "ok");
      } catch (error) {
        addLog(`按键写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        setBusy(false);
      }
    },
    [addLog, transact],
  );

  const online = state === "online";
  const stateLabel = {
    idle: "等待连接",
    connecting: "握手中",
    online: "配置通道在线",
    stalled: "枚举在线 / 固件无响应",
    unsupported: "浏览器不支持 WebHID",
  }[state];
  const stateTone = state === "online" ? "good" : state === "stalled" ? "bad" : "wait";
  const activeValue = dpi[activeDpi] ?? 0;
  const fingerprint = useMemo(() => `${hex(VID)} · ${hex(PID)} · 0xFFC1`, []);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">G6</span>
          <div>
            <p>KEYCHRON / DEVICE LAB</p>
            <h1>HE CONTROL</h1>
          </div>
        </div>
        <div className={`status ${stateTone}`}><span />{stateLabel}</div>
        <button className="connect" onClick={connect} disabled={busy || state === "unsupported"}>
          {online ? "重新读取" : "连接 G6 HE"}
        </button>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">LOCAL WEBHID · NO CLOUD WRITE</p>
          <h2>把性能调准，<br /><em>先让固件醒来。</em></h2>
          <p className="lede">专为当前 G6 HE（VID 3434 / PID D086）制作。配置先握手、后写入；无法确认的 8K 与 20K FPS 指令不会盲发。</p>
        </div>
        <div className="device-plate">
          <div className="mouse-wire" />
          <div className="mouse-body">
            <i className="split" />
            <i className="wheel" />
            <i className="sensor" />
            <span>G6 HE</span>
          </div>
          <div className="plate-meta">
            <span>{fingerprint}</span>
            <span>MAGOPTIC / 光微动模式</span>
          </div>
        </div>
      </section>

      <section className="telemetry">
        <article><small>FIRMWARE</small><strong>{firmware}</strong><span>本机读取</span></article>
        <article><small>ACTIVE DPI</small><strong>{activeValue || "—"}</strong><span>5 档配置</span></article>
        <article><small>POLLING</small><strong>{polling}<b> Hz</b></strong><span>USB 当前档</span></article>
        <article><small>BATTERY</small><strong>{battery === null ? "—" : battery}<b>{battery === null ? "" : "%"}</b></strong><span>有线状态</span></article>
      </section>

      <div className="grid">
        <section className="panel span2">
          <div className="panel-head">
            <div><small>01 / SENSOR</small><h3>DPI 曲线</h3></div>
            <button className="ghost" onClick={applyDpi} disabled={!online || busy}>写入 DPI</button>
          </div>
          <div className="dpi-grid">
            {dpi.map((value, index) => (
              <label className={activeDpi === index ? "dpi-card active" : "dpi-card"} key={index}>
                <button onClick={() => setActiveDpi(index)} aria-label={`选择 DPI 档 ${index + 1}`}>
                  <span>0{index + 1}</span><b>{value}</b><small>DPI</small>
                </button>
                <input
                  type="number"
                  min={50}
                  max={30000}
                  step={50}
                  value={value}
                  onChange={(event) => {
                    const next = [...dpi];
                    next[index] = Math.max(50, Math.min(30000, Number(event.target.value)));
                    setDpi(next);
                  }}
                />
              </label>
            ))}
          </div>
          <p className="hint">Launcher 的 G6 HE 配置上限是 30,000 DPI；产品规格写 40,000 DPI。当前页面按实际驱动上限保护写入。</p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div><small>02 / REPORT RATE</small><h3>回报率</h3></div>
            <button className="ghost" onClick={applyPolling} disabled={!online || busy || polling > 1000}>写入</button>
          </div>
          <div className="rate-list">
            {POLLING.map((value) => {
              const locked = value > 1000;
              return (
                <button key={value} className={polling === value ? "rate active" : "rate"} onClick={() => setPolling(value)}>
                  <span>{value >= 1000 ? `${value / 1000}K` : value}</span>
                  <small>{locked ? "固件未开放" : "可写"}</small>
                </button>
              );
            })}
          </div>
          <div className="warning"><b>协议缺口</b><span>硬件/产品页宣称 8K，但 v1.0.0+5 的 1K Feature 协议只返回 3 档。</span></div>
        </section>

        <section className="panel">
          <div className="panel-head"><div><small>03 / SENSOR FPS</small><h3>20K FPS</h3></div><span className="chip warn">LOCKED</span></div>
          <button className={fps20k ? "toggle on" : "toggle"} onClick={() => setFps20k(!fps20k)} disabled>
            <span><b>PAW3955 高速扫描</b><small>13K → 20K FPS</small></span><i />
          </button>
          <label className="select-line">
            <span>抬升距离 LOD</span>
            <select value={lod} onChange={(event) => setLod(Number(event.target.value))} disabled={!online}>
              <option value={3}>0.7 mm</option>
              <option value={1}>1.0 mm</option>
              <option value={2}>2.0 mm</option>
            </select>
          </label>
          <p className="hint">当前协议的能力位明确返回 fps20kSupport=false，且 0x42 指令没有 FPS 字段，因此保持锁定。</p>
        </section>

        <section className="panel span2">
          <div className="panel-head">
            <div><small>04 / KEYMAP</small><h3>按键映射</h3></div>
            <button className="ghost" onClick={readMappings} disabled={!online || busy}>重新读取</button>
          </div>
          <div className="keymap">
            {BUTTONS.map((button) => (
              <label key={button.index}>
                <span><b>{button.label}</b><small>INDEX {button.index}</small></span>
                <select
                  value={mappings[button.index] ?? button.label}
                  onChange={(event) => applyMapping(button.index, event.target.value)}
                  disabled={!online || busy}
                >
                  {Object.keys(mappingValue).map((name) => <option key={name}>{name}</option>)}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section className="panel recovery">
          <div className="panel-head"><div><small>05 / RECOVERY</small><h3>死机恢复</h3></div><span className={`chip ${stateTone}`}>{stateLabel}</span></div>
          <ol>
            <li><b>重开配置通道</b><span>只关闭/打开 WebHID，不改固件。</span></li>
            <li><b>安全冷启动</b><span>拔线 → OFF 15 秒 → 直连 → ON。</span></li>
            <li><b>仍无输入时停止</b><span>保留固件与现场，不尝试未知组合键。</span></li>
          </ol>
          <button className="recover-button" onClick={reconnect} disabled={busy || !hasDevice}>执行可逆重连</button>
        </section>

        <section className="panel console-panel">
          <div className="panel-head"><div><small>LIVE / TRACE</small><h3>设备日志</h3></div><span className="chip">{protocol}</span></div>
          <div className="console">
            {logs.map((item, index) => (
              <p key={`${item.at}-${index}`} className={item.level}><time>{item.at}</time><span>{item.text}</span></p>
            ))}
          </div>
        </section>
      </div>

      <footer>
        <span>G6 HE CONTROL LAB / BUILD 2026.07.23</span>
        <span>所有写入仅发送到已明确选择的 {hex(VID)}:{hex(PID)}</span>
      </footer>
    </main>
  );
}
