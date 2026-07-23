"use client";

import { useCallback, useMemo, useRef, useState } from "react";

const VID = 0x3434;
const LEGACY_PID = 0xd086;
const DIY_PID = 0xd687;
const REPORT_ID = 0x51;
const FRAME_SIZE = 63;
const POLLING = [125, 500, 1000, 2000, 4000, 8000];
const DEFAULT_DPI = [400, 800, 1600, 3200, 5000];
const BUTTONS = [
  { label: "左键", diyIndex: 0, legacyIndex: 0 },
  { label: "右键", diyIndex: 1, legacyIndex: 2 },
  { label: "中键", diyIndex: 2, legacyIndex: 1 },
  { label: "后退", diyIndex: 3, legacyIndex: 3 },
  { label: "前进", diyIndex: 4, legacyIndex: 4 },
];
const ACTIONS: Record<string, number> = {
  "禁用": 0,
  "左键": 1,
  "右键": 2,
  "中键": 3,
  "后退": 4,
  "前进": 5,
};
const ACTION_NAMES = Object.fromEntries(
  Object.entries(ACTIONS).map(([name, value]) => [value, name]),
) as Record<number, string>;
const LEGACY_CODES: Record<string, number | null> = {
  "左键": 0x010000,
  "右键": 0x020000,
  "中键": 0x040000,
  "后退": 0x100000,
  "前进": 0x080000,
  "禁用": null,
};
const STATUS_TEXT = [
  "OK",
  "magic 错误",
  "协议版本错误",
  "长度错误",
  "CRC 错误",
  "命令错误",
  "参数错误",
  "设备未就绪",
  "尚未实现",
];

type DeviceState = "idle" | "connecting" | "online" | "stalled" | "unsupported";
type ProtocolMode = "none" | "legacy" | "diy";
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
type Health = {
  uptime: number;
  reports: number;
  usbErrors: number;
  sensor: boolean;
  buttons: boolean;
  watchdog: number;
};

function hex(value: number, size = 4) {
  return `0x${value.toString(16).toUpperCase().padStart(size, "0")}`;
}

function now() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeFeature(view: DataView, reportId: number) {
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return raw[0] === reportId ? raw.slice(1) : raw;
}

function get16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function get32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function put16(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function put32(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = (crc ^ value) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ (0xedb88320 & -(crc & 1))) >>> 0;
    }
  }
  return (~crc) >>> 0;
}

function makeFrame(sequence: number, command: number, payload: number[] = []) {
  if (payload.length > 50) throw new Error("配置负载超过 50 字节");
  const frame = new Uint8Array(FRAME_SIZE);
  frame.set([0x47, 0x36, 0x48, 0x31, 1, sequence & 0xff, command, 0, payload.length]);
  frame.set(payload, 9);
  put32(frame, 59, crc32(frame.slice(0, 59)));
  return frame;
}

function validateFrame(frame: Uint8Array, sequence: number, command: number) {
  if (frame.length !== FRAME_SIZE) throw new Error(`DIY 响应长度异常：${frame.length}`);
  if (String.fromCharCode(...frame.slice(0, 4)) !== "G6H1") throw new Error("DIY 响应 magic 错误");
  if (frame[4] !== 1 || frame[5] !== sequence || frame[6] !== command) {
    throw new Error("DIY 响应序号或命令不匹配");
  }
  if (frame[8] > 50) throw new Error("DIY 响应负载长度越界");
  if (get32(frame, 59) !== crc32(frame.slice(0, 59))) throw new Error("DIY 响应 CRC 错误");
  if (frame[7] !== 0) throw new Error(STATUS_TEXT[frame[7]] ?? `状态 ${frame[7]}`);
  return frame.slice(9, 9 + frame[8]);
}

function decodeLegacy(bytes: Uint8Array) {
  const value = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  const found = Object.entries(LEGACY_CODES).find(([, code]) => code === value);
  return found?.[0] ?? `未知 ${hex(value, 6)}`;
}

export function G6Console() {
  const [state, setState] = useState<DeviceState>("idle");
  const [mode, setMode] = useState<ProtocolMode>("none");
  const [dpi, setDpi] = useState(DEFAULT_DPI);
  const [activeDpi, setActiveDpi] = useState(2);
  const [polling, setPolling] = useState(1000);
  const [fps20k, setFps20k] = useState(false);
  const [firmware, setFirmware] = useState("未读取");
  const [protocol, setProtocol] = useState("等待握手");
  const [battery, setBattery] = useState<number | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [mappings, setMappings] = useState<Mapping>({
    0: "左键", 1: "右键", 2: "中键", 3: "后退", 4: "前进",
  });
  const [logs, setLogs] = useState<LogItem[]>([
    { at: "BOOT", level: "info", text: "控制台就绪；支持原厂诊断和 DIY 固件配置。" },
  ]);
  const [busy, setBusy] = useState(false);
  const [hasDevice, setHasDevice] = useState(false);
  const deviceRef = useRef<HidDeviceLike | null>(null);
  const sequenceRef = useRef(0);
  const diyMapRef = useRef([1, 2, 3, 4, 5, 6, 7, 0]);

  const addLog = useCallback((text: string, level: LogItem["level"] = "info") => {
    setLogs((items) => [{ at: now(), level, text }, ...items].slice(0, 18));
  }, []);

  const rawTransaction = useCallback(async (reportId: number, payload: Uint8Array) => {
    const device = deviceRef.current;
    if (!device?.opened) throw new Error("设备未连接");
    await device.sendFeatureReport(reportId, payload);
    return normalizeFeature(await device.receiveFeatureReport(reportId), reportId);
  }, []);

  const diyTransaction = useCallback(async (command: number, payload: number[] = []) => {
    const sequence = (sequenceRef.current = (sequenceRef.current + 1) & 0xff);
    const response = await rawTransaction(REPORT_ID, makeFrame(sequence, command, payload));
    return validateFrame(response, sequence, command);
  }, [rawTransaction]);

  const legacyTransaction = useCallback(async (reportId: number, payload: Uint8Array, expected: number) => {
    const response = await rawTransaction(reportId, payload);
    if (!response.length || response[0] !== expected) {
      throw new Error(`原厂响应异常：期望 ${hex(expected, 2)}`);
    }
    return response;
  }, [rawTransaction]);

  const readDiy = useCallback(async () => {
    const capabilities = await diyTransaction(0x01);
    const config = await diyTransaction(0x02);
    const status = await diyTransaction(0x30);
    const currentDpi = get16(config, 0);
    const presetIndex = dpi.indexOf(currentDpi);
    const index = presetIndex >= 0 ? presetIndex : activeDpi;
    const nextDpi = [...dpi];
    nextDpi[index] = currentDpi;
    const nextMap = Array.from(config.slice(7, 15));

    diyMapRef.current = nextMap;
    setDpi(nextDpi);
    setActiveDpi(index);
    setPolling(get16(config, 2));
    setFps20k(get16(config, 4) === 20000);
    setMappings(Object.fromEntries(nextMap.slice(0, 5).map((value, i) => [i, ACTION_NAMES[value] ?? "禁用"])));
    setFirmware("DIY 1.0 · Sensor 0x6E");
    setProtocol("G6H1 / CRC32 / Report 0x51");
    setBattery(null);
    setHealth({
      uptime: get32(status, 0),
      reports: get32(status, 8),
      usbErrors: get32(status, 12),
      watchdog: get32(status, 16),
      sensor: status[24] === 1,
      buttons: status[25] === 1,
    });
    setMode("diy");
    addLog(
      `DIY 握手成功：DPI ${currentDpi}，${get16(config, 2)} Hz，20K ${get16(config, 4) === 20000 ? "开启" : "关闭"}；能力位 ${hex(get32(capabilities, 12), 8)}。`,
      "ok",
    );
  }, [activeDpi, addLog, diyTransaction, dpi]);

  const readLegacy = useCallback(async () => {
    const baseRequest = new Uint8Array(20);
    baseRequest[0] = 7;
    const base = await legacyTransaction(0x51, baseRequest, 7);
    const currentDpi = base[2] & 0x0f;
    const currentPolling = (base[2] >> 4) & 0x0f;
    const values = Array.from({ length: 5 }, (_, i) => get16(base, 5 + i * 2));
    const cleanValues = values.every((value) => value > 0) ? values : DEFAULT_DPI;

    setActiveDpi(Math.min(currentDpi, 4));
    setDpi(cleanValues);
    setPolling([125, 500, 1000][currentPolling] ?? 1000);

    const infoRequest = new Uint8Array(20);
    infoRequest[0] = 6;
    const info = await legacyTransaction(0x51, infoRequest, 6);
    const version = `${info[8]}.${(info[7] >> 4) & 0x0f}.${info[7] & 0x0f}`;
    setFirmware(version);
    setBattery(info[10]);
    setProtocol("原厂 1K Feature / 0x51");
    setFps20k(false);
    setHealth(null);
    setMode("legacy");
    addLog(`原厂握手成功：FW ${version}。2K–8K 与 20K 写入保持锁定。`, "warn");
  }, [addLog, legacyTransaction]);

  const readMappings = useCallback(async () => {
    if (mode === "diy") {
      const config = await diyTransaction(0x02);
      const nextMap = Array.from(config.slice(7, 15));
      diyMapRef.current = nextMap;
      setMappings(Object.fromEntries(nextMap.slice(0, 5).map((value, i) => [i, ACTION_NAMES[value] ?? "禁用"])));
      addLog("已读取 DIY 固件的 8 个映射槽。", "ok");
      return;
    }
    if (mode !== "legacy") throw new Error("设备协议尚未识别");
    const next: Mapping = {};
    for (const button of BUTTONS) {
      const request = new Uint8Array(64);
      request[0] = 98;
      request[1] = button.legacyIndex;
      const response = await legacyTransaction(0x52, request, 98);
      next[button.diyIndex] = response[3] === 1
        ? decodeLegacy(response.slice(4, 7))
        : response[3] === 9 ? "禁用" : `功能类型 ${response[3]}`;
    }
    setMappings(next);
    addLog("已读取原厂固件 5 个主按键映射。", "ok");
  }, [addLog, diyTransaction, legacyTransaction, mode]);

  const readCurrentDevice = useCallback(async () => {
    const device = deviceRef.current;
    if (!device) throw new Error("设备不存在");
    if (device.productId === DIY_PID) await readDiy();
    else await readLegacy();
  }, [readDiy, readLegacy]);

  const connect = useCallback(async () => {
    const hid = (navigator as HidNavigator).hid;
    if (!hid) {
      setState("unsupported");
      return;
    }
    setBusy(true);
    setState("connecting");
    try {
      const granted = (await hid.getDevices()).filter(
        (device) => device.vendorId === VID &&
          (device.productId === DIY_PID || device.productId === LEGACY_PID),
      );
      const devices = granted.length
        ? granted
        : await hid.requestDevice({
          filters: [
            { vendorId: VID, productId: DIY_PID },
            { vendorId: VID, productId: LEGACY_PID },
          ],
        });
      if (devices.length !== 1) throw new Error(`需要唯一一只 G6 HE，当前选择 ${devices.length} 个`);
      const device = devices[0];
      const hasConfig = device.collections?.some(
        (item) => item.usagePage === 0xff00 || item.usagePage === 0xffc1,
      );
      if (!hasConfig) throw new Error("未发现 G6 配置接口");
      if (!device.opened) await device.open();
      deviceRef.current = device;
      setHasDevice(true);
      await (device.productId === DIY_PID ? readDiy() : readLegacy());
      setState("online");
    } catch (error) {
      setState("stalled");
      setMode("none");
      addLog(`连接/握手失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, readDiy, readLegacy]);

  const reconnect = useCallback(async () => {
    setBusy(true);
    addLog("关闭并重新打开当前 WebHID 会话。");
    try {
      const device = deviceRef.current;
      if (!device) throw new Error("请先连接设备");
      if (device.opened) await device.close();
      await device.open();
      await readCurrentDevice();
      setState("online");
      addLog("重连完成，配置通道有响应。", "ok");
    } catch (error) {
      setState("stalled");
      addLog(`重连无效：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, readCurrentDevice]);

  const applyDpi = useCallback(async () => {
    setBusy(true);
    try {
      const value = Math.max(1, Math.min(40000, dpi[activeDpi]));
      if (mode === "diy") {
        await diyTransaction(0x10, [value & 0xff, value >> 8]);
      } else if (mode === "legacy") {
        if (dpi.some((item) => item > 30000)) throw new Error("原厂协议上限为 30000 DPI");
        const payload = new Uint8Array(20);
        payload.set([64, activeDpi, activeDpi, activeDpi]);
        dpi.forEach((item, i) => put16(payload, 4 + i * 2, item));
        payload[14] = 5;
        await legacyTransaction(0x51, payload, 64);
      } else {
        throw new Error("设备协议尚未识别");
      }
      addLog(`DPI 已写入：${value}。`, "ok");
      await readCurrentDevice();
    } catch (error) {
      addLog(`DPI 写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [activeDpi, addLog, diyTransaction, dpi, legacyTransaction, mode, readCurrentDevice]);

  const applyPolling = useCallback(async () => {
    setBusy(true);
    try {
      if (mode === "diy") {
        await diyTransaction(0x11, [polling & 0xff, polling >> 8]);
        addLog(`回报率已写入：${polling} Hz；USB 正在按新端点周期重新枚举。`, "ok");
        await wait(1000);
        const hid = (navigator as HidNavigator).hid;
        if (!hid) throw new Error("浏览器不支持 WebHID");
        const devices = (await hid.getDevices()).filter(
          (device) => device.vendorId === VID && device.productId === DIY_PID,
        );
        if (devices.length !== 1) {
          throw new Error(`USB 重枚举后需要唯一一只 DIY G6 HE，当前 ${devices.length} 只`);
        }
        const device = devices[0];
        if (!device.opened) await device.open();
        deviceRef.current = device;
        await readDiy();
      } else if (mode === "legacy") {
        const level = [125, 500, 1000].indexOf(polling);
        if (level < 0) throw new Error("原厂固件仅开放 125 / 500 / 1000 Hz");
        const payload = new Uint8Array(20);
        payload.set([65, level, level, 0, 1, 2]);
        await legacyTransaction(0x51, payload, 65);
      } else {
        throw new Error("设备协议尚未识别");
      }
      if (mode === "legacy") {
        addLog(`回报率已写入：${polling} Hz。`, "ok");
        await readCurrentDevice();
      }
    } catch (error) {
      addLog(`回报率写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, diyTransaction, legacyTransaction, mode, polling, readCurrentDevice, readDiy]);

  const applyFps20k = useCallback(async () => {
    setBusy(true);
    try {
      if (mode !== "diy") throw new Error("20K 仅由 DIY 固件的已验证 0x6E profile 开放");
      await diyTransaction(0x12, [0x20, 0x4e]);
      setFps20k(true);
      addLog("传感器已保持 20K 高性能 profile。", "ok");
      await readCurrentDevice();
    } catch (error) {
      addLog(`20K 设置失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, diyTransaction, mode, readCurrentDevice]);

  const applyMapping = useCallback(async (diyIndex: number, value: string) => {
    setBusy(true);
    try {
      if (mode === "diy") {
        const next = [...diyMapRef.current];
        next[diyIndex] = ACTIONS[value];
        await diyTransaction(0x13, next);
        diyMapRef.current = next;
      } else if (mode === "legacy") {
        const button = BUTTONS.find((item) => item.diyIndex === diyIndex);
        if (!button) throw new Error("按键索引不存在");
        const payload = new Uint8Array(64);
        payload[0] = 82;
        payload[1] = button.legacyIndex;
        payload[3] = value === "禁用" ? 9 : 1;
        const code = LEGACY_CODES[value];
        if (code !== null && code !== undefined) {
          payload[4] = (code >> 16) & 0xff;
          payload[5] = (code >> 8) & 0xff;
          payload[6] = code & 0xff;
        }
        await legacyTransaction(0x52, payload, 82);
      } else {
        throw new Error("设备协议尚未识别");
      }
      setMappings((items) => ({ ...items, [diyIndex]: value }));
      addLog(`${BUTTONS[diyIndex].label}已改为“${value}”。`, "ok");
    } catch (error) {
      addLog(`按键写入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  }, [addLog, diyTransaction, legacyTransaction, mode]);

  const online = state === "online";
  const stateLabel = {
    idle: "等待连接",
    connecting: "握手中",
    online: mode === "diy" ? "DIY 固件在线" : "原厂固件在线",
    stalled: "枚举在线 / 固件无响应",
    unsupported: "浏览器不支持 WebHID",
  }[state];
  const stateTone = state === "online" ? "good" : state === "stalled" ? "bad" : "wait";
  const activeValue = dpi[activeDpi] ?? 0;
  const fingerprint = useMemo(
    () => `${hex(VID)} · ${hex(DIY_PID)} DIY / ${hex(LEGACY_PID)} 原厂`,
    [],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">G6</span>
          <div><p>KEYCHRON / DEVICE LAB</p><h1>HE CONTROL</h1></div>
        </div>
        <div className={`status ${stateTone}`}><span />{stateLabel}</div>
        <button className="connect" onClick={connect} disabled={busy || state === "unsupported"}>
          {online ? "重新读取" : "连接 G6 HE"}
        </button>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">LOCAL WEBHID · CRC-GUARDED CONFIG</p>
          <h2>把性能调准，<br /><em>也让固件自愈。</em></h2>
          <p className="lede">DIY 固件开放 40K DPI、8K 回报率、20K 传感器 profile 与主按键映射；原厂固件保留只读诊断和已验证的 1K 安全写入。</p>
        </div>
        <div className="device-plate">
          <div className="mouse-wire" />
          <div className="mouse-body"><i className="split" /><i className="wheel" /><i className="sensor" /><span>G6 HE</span></div>
          <div className="plate-meta"><span>{fingerprint}</span><span>OPTICAL / 光微动</span></div>
        </div>
      </section>

      <section className="telemetry">
        <article><small>FIRMWARE</small><strong>{firmware}</strong><span>{mode === "diy" ? "自研恢复版" : "本机读取"}</span></article>
        <article><small>ACTIVE DPI</small><strong>{activeValue || "—"}</strong><span>最高 40,000</span></article>
        <article><small>POLLING</small><strong>{polling}<b> Hz</b></strong><span>最高 8,000</span></article>
        <article><small>SENSOR</small><strong>{health ? (health.sensor ? "READY" : "RECOVER") : battery === null ? "—" : `${battery}%`}</strong><span>{health ? `USB ERR ${health.usbErrors}` : "原厂状态"}</span></article>
      </section>

      <div className="grid">
        <section className="panel span2">
          <div className="panel-head"><div><small>01 / SENSOR</small><h3>DPI 预设</h3></div><button className="ghost" onClick={applyDpi} disabled={!online || busy}>写入当前档</button></div>
          <div className="dpi-grid">
            {dpi.map((value, index) => (
              <label className={activeDpi === index ? "dpi-card active" : "dpi-card"} key={index}>
                <button onClick={() => setActiveDpi(index)} aria-label={`选择 DPI 档 ${index + 1}`}><span>0{index + 1}</span><b>{value}</b><small>DPI</small></button>
                <input
                  type="number"
                  min={mode === "legacy" ? 50 : 1}
                  max={mode === "legacy" ? 30000 : 40000}
                  step={mode === "legacy" ? 50 : 1}
                  value={value}
                  onChange={(event) => {
                    const next = [...dpi];
                    const max = mode === "legacy" ? 30000 : 40000;
                    next[index] = Math.max(mode === "legacy" ? 50 : 1, Math.min(max, Number(event.target.value)));
                    setDpi(next);
                  }}
                />
              </label>
            ))}
          </div>
          <p className="hint">{mode === "legacy" ? "原厂协议按 50–30,000 DPI 保护写入。" : "DIY 固件按传感器 profile 开放 1–40,000 DPI；预设保存在此浏览器，当前档写入鼠标。"}</p>
        </section>

        <section className="panel">
          <div className="panel-head"><div><small>02 / REPORT RATE</small><h3>回报率</h3></div><button className="ghost" onClick={applyPolling} disabled={!online || busy || (mode === "legacy" && polling > 1000)}>写入</button></div>
          <div className="rate-list">
            {POLLING.map((value) => {
              const locked = mode !== "diy" && value > 1000;
              return <button key={value} className={polling === value ? "rate active" : "rate"} onClick={() => setPolling(value)} disabled={locked}><span>{value >= 1000 ? `${value / 1000}K` : value}</span><small>{locked ? "DIY 固件" : "可写"}</small></button>;
            })}
          </div>
          <div className="warning"><b>{mode === "diy" ? "高速 USB" : "协议边界"}</b><span>{mode === "diy" ? "写入后 USB 自动重枚举，页面会按新端点周期重连。" : "原厂 D086 只开放 125 / 500 / 1000 Hz。"}</span></div>
        </section>

        <section className="panel">
          <div className="panel-head"><div><small>03 / SENSOR FPS</small><h3>20K FPS</h3></div><span className={`chip ${mode === "diy" && fps20k ? "good" : "warn"}`}>{mode === "diy" ? (fps20k ? "ACTIVE" : "READY") : "DIY ONLY"}</span></div>
          <button className={fps20k ? "toggle on" : "toggle"} onClick={applyFps20k} disabled={!online || busy || mode !== "diy"}>
            <span><b>0x6E 高性能 profile</b><small>量产表逐字节复现</small></span><i />
          </button>
          <p className="hint">DIY 固件只开放已验证的 20K 档；不会把未确认的中间帧率写进传感器。</p>
        </section>

        <section className="panel span2">
          <div className="panel-head"><div><small>04 / KEYMAP</small><h3>按键映射</h3></div><button className="ghost" onClick={readMappings} disabled={!online || busy}>重新读取</button></div>
          <div className="keymap">
            {BUTTONS.map((button) => (
              <label key={button.diyIndex}>
                <span><b>{button.label}</b><small>INDEX {button.diyIndex}</small></span>
                <select value={mappings[button.diyIndex] ?? button.label} onChange={(event) => applyMapping(button.diyIndex, event.target.value)} disabled={!online || busy}>
                  {Object.keys(ACTIONS).map((name) => <option key={name}>{name}</option>)}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section className="panel recovery">
          <div className="panel-head"><div><small>05 / RECOVERY</small><h3>死机恢复</h3></div><span className={`chip ${stateTone}`}>{stateLabel}</span></div>
          <ol>
            <li><b>SPI 连续失败隔离</b><span>按键/USB 保持工作，不被传感器拖死。</span></li>
            <li><b>传感器自动重启</b><span>失败 8 次后每秒重试完整启动。</span></li>
            <li><b>独立看门狗</b><span>主循环卡住超过 1.5 秒自动复位。</span></li>
          </ol>
          <button className="recover-button" onClick={reconnect} disabled={busy || !hasDevice}>重开配置通道</button>
        </section>

        <section className="panel console-panel">
          <div className="panel-head"><div><small>LIVE / TRACE</small><h3>设备日志</h3></div><span className="chip">{protocol}</span></div>
          <div className="console">
            {health && <p className="ok"><time>HEALTH</time><span>UP {Math.floor(health.uptime / 1000)}s · REPORT {health.reports} · WDT {health.watchdog} · BTN {health.buttons ? "OK" : "FAIL"}</span></p>}
            {logs.map((item, index) => <p key={`${item.at}-${index}`} className={item.level}><time>{item.at}</time><span>{item.text}</span></p>)}
          </div>
        </section>
      </div>

      <footer><span>G6 HE CONTROL LAB / DIY BUILD 2026.07.23</span><span>所有写入仅发送到手动选择的唯一 G6 HE</span></footer>
    </main>
  );
}
