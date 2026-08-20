const manualSchedules = new Set(["", "手动运行", "manual"]);

export type ScheduleParts = { minute: number; hour: number; day: number; month: number; weekday: number };

function localParts(date: Date, timeZone: string): ScheduleParts & { year: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdays[values.weekday as keyof typeof weekdays],
  };
}

function parseValue(value: string, min: number, max: number, label: string): number[] | null {
  const output = new Set<number>();
  for (const item of value.split(",")) {
    const [range, stepText] = item.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    const [startText, endText] = range === "*" ? [String(min), String(max)] : range.split("-");
    const start = startText === undefined ? Number.NaN : Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null;
    for (let current = start; current <= end; current += step) output.add(current);
  }
  if (!output.size) throw new Error(`${label} 不能为空`);
  return [...output].sort((a, b) => a - b);
}

export function parseCronSchedule(value: string): ScheduleParts | null {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseValue(fields[0]!, 0, 59, "分钟");
  const hour = parseValue(fields[1]!, 0, 23, "小时");
  const day = parseValue(fields[2]!, 1, 31, "日期");
  const month = parseValue(fields[3]!, 1, 12, "月份");
  const weekday = parseValue(fields[4]!, 0, 7, "星期")?.map((item) => (item === 7 ? 0 : item));
  if (!minute || !hour || !day || !month || !weekday) return null;
  return { minute: minute[0]!, hour: hour[0]!, day: day[0]!, month: month[0]!, weekday: weekday[0]! };
}

function cronMatches(value: string, parts: ScheduleParts): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [parts.minute, parts.hour, parts.day, parts.month, parts.weekday];
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
  return fields.every((field, index) => parseValue(field!, ranges[index]![0], ranges[index]![1], "cron")?.some((item) => (index === 4 && item === 7 ? 0 : item) === values[index]) ?? false);
}

function dailyMatch(value: string): { hour: number; minute: number; weekdays?: Set<number> } | null {
  const match = /^(?:每天|daily)\s+(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function weekdayMatch(value: string): { hour: number; minute: number } | null {
  const match = /^(?:工作日|weekdays)\s+(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function hourlyMatch(value: string): boolean {
  return /^(?:每小时|hourly)$/i.test(value.trim());
}

export function isManualSchedule(value: string | null | undefined): boolean {
  return manualSchedules.has((value ?? "").trim().toLowerCase());
}

export function isSupportedSchedule(value: string | null | undefined): boolean {
  const schedule = value?.trim() ?? "";
  return isManualSchedule(schedule) || Boolean(dailyMatch(schedule) || weekdayMatch(schedule) || hourlyMatch(schedule) || parseCronSchedule(schedule));
}

export function isSupportedTimeZone(value: string | null | undefined): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value?.trim() || "" }).format();
    return true;
  } catch {
    return false;
  }
}

/** Returns the next occurrence. Cron expressions use five fields and are
 * evaluated in the supplied IANA timezone. Human presets are intentionally
 * small and stable so the UI can explain them without exposing cron syntax. */
export function nextScheduledAt(schedule: string | null | undefined, after = new Date(), timeZone = "Asia/Shanghai"): Date | null {
  const value = schedule?.trim() ?? "";
  if (isManualSchedule(value)) return null;
  const daily = dailyMatch(value);
  const weekdays = weekdayMatch(value);
  const hourly = hourlyMatch(value);
  const cron = parseCronSchedule(value);
  if (!daily && !weekdays && !hourly && !cron) return null;

  const cursor = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  for (let offset = 0; offset <= 366 * 24 * 60; offset += 1) {
    const candidate = new Date(cursor.getTime() + offset * 60_000);
    const parts = localParts(candidate, timeZone);
    let matches = false;
    if (daily) matches = parts.hour === daily.hour && parts.minute === daily.minute;
    else if (weekdays) matches = parts.weekday >= 1 && parts.weekday <= 5 && parts.hour === weekdays.hour && parts.minute === weekdays.minute;
    else if (hourly) matches = parts.minute === 0;
    else matches = cronMatches(value, { minute: parts.minute, hour: parts.hour, day: parts.day, month: parts.month, weekday: parts.weekday });
    if (matches) return candidate;
  }
  return null;
}

export function scheduleDescription(value: string | null | undefined): string {
  if (isManualSchedule(value)) return "手动运行";
  if (dailyMatch(value ?? "")) return value!.trim();
  if (weekdayMatch(value ?? "")) return value!.trim();
  if (hourlyMatch(value ?? "")) return "每小时";
  if (parseCronSchedule(value ?? "")) return `cron ${value!.trim()}`;
  return "未识别的计划";
}
