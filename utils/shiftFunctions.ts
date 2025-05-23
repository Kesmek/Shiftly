import type { Shift } from "@/db/schema";
import { clamp, clampDuration } from "./helpers";
import { type CompleteShift, OTCycle } from "./typescript";

export const isOutsidePaycycle = (
  paycycleStart: Temporal.PlainDate,
  paycycleEnd: Temporal.PlainDate,
  startTime: Temporal.PlainDate,
) => {
  return isBeforePaycycle(paycycleStart, startTime)
    ? -1
    : isAfterPaycycle(paycycleEnd, startTime)
      ? 1
      : 0;
};

export const isBeforePaycycle = (
  paycycleStart: Temporal.PlainDate,
  punchInTime: Temporal.PlainDate,
) => {
  return Temporal.PlainDate.compare(punchInTime, paycycleStart) < 0;
};

export const isAfterPaycycle = (
  paycycleEnd: Temporal.PlainDate,
  punchInTime: Temporal.PlainDate,
) => {
  return Temporal.PlainDate.compare(punchInTime, paycycleEnd) >= 0;
};

export const getNextStartDate = (
  currentPayrollPeriod: Temporal.PlainDate,
  paycycleDays: number,
) => {
  return currentPayrollPeriod.add({ days: paycycleDays });
};

export const getPrevStartDate = (
  currentPayrollPeriod: Temporal.PlainDate,
  paycycleDays: number,
) => {
  return currentPayrollPeriod.subtract({ days: paycycleDays });
};

const getRawTotalShiftDuration = (shifts: Shift[]) =>
  shifts.reduce(
    (acc, shift) =>
      acc.add(
        // If no endTime i.e. ongoing do not include shift in duration calculation
        shift.endTime
          ? Temporal.Instant.from(shift.endTime).since(shift.startTime)
          : Temporal.Duration.from({ seconds: 0 }),
      ),
    Temporal.Duration.from({ seconds: 0 }),
  );

const getTotalShiftDuration = (shifts: Shift[], breakDurationMins: number) =>
  shifts.reduce(
    (acc, shift) =>
      acc.add(
        clampDuration(
          shift.endTime
            ? Temporal.Instant.from(shift.endTime)
                .since(shift.startTime)
                .subtract({
                  minutes: breakDurationMins,
                })
            : Temporal.Duration.from({ seconds: 0 }),
          Temporal.Duration.from({ hours: 3 }),
        ),
      ),
    Temporal.Duration.from({ seconds: 0 }),
  );

const durationToHours = (duration: Temporal.Duration) =>
  clamp(0, duration.total({ unit: "hours" })).toPrecision(3);

export const getPaycycleStats = (
  shifts: Shift[],
  overtimeCycle: number,
  overtimeBoundaryMins: number,
  breakDurationMins: number,
  paycycleStartDate: Temporal.PlainDate,
  timezone: Temporal.TimeZoneLike,
) => {
  const totalDuration = getRawTotalShiftDuration(shifts);
  const totalDurationAdjusted = getTotalShiftDuration(
    shifts,
    breakDurationMins,
  );
  let totalOvertimeDuration = Temporal.Duration.from({ seconds: 0 });

  if (overtimeCycle === OTCycle.Day) {
    totalOvertimeDuration = getOvertimeHoursDaily(
      shifts,
      overtimeBoundaryMins,
      Temporal.Duration.from({ minutes: breakDurationMins }),
    );
  } else {
    totalOvertimeDuration = getOvertimeHoursWeekly(
      shifts,
      overtimeBoundaryMins,
      breakDurationMins,
      paycycleStartDate,
      timezone,
    );
  }

  const { weekOneTotalDuration, weekTwoTotalDuration } = getWeeklyStats(
    shifts,
    breakDurationMins,
    paycycleStartDate,
    timezone,
  );

  return {
    totalHours: durationToHours(totalDuration),
    totalHoursAdjusted: durationToHours(totalDurationAdjusted),
    totalRegularHours: durationToHours(
      totalDurationAdjusted.subtract(totalOvertimeDuration),
    ),
    totalovertimeHours: durationToHours(totalOvertimeDuration),
    totalWeekOneHours: durationToHours(weekOneTotalDuration),
    totalWeekTwoHours: durationToHours(weekTwoTotalDuration),
  };
};

export const getWeeklyStats = (
  shifts: Shift[],
  breakDurationMins: number,
  paycycleStartDate: Temporal.PlainDate,
  timezone: Temporal.TimeZoneLike,
) => {
  //get the shifts in the first of the 2 weeks
  const firstWeekEndDate = paycycleStartDate.add({ weeks: 1 });
  const weekOneShifts = shifts.filter(
    (shift) =>
      //check if the start time is earlier than one week after the paycycles' start
      Temporal.PlainDate.compare(
        Temporal.PlainDate.from(
          Temporal.Instant.from(shift.startTime)
            .toZonedDateTimeISO(timezone)
            .toPlainDate(),
        ),
        firstWeekEndDate,
      ) < 0,
  );
  const weekTwoShifts = shifts.filter(
    (shift) => !weekOneShifts.includes(shift),
  );
  const weekOneTotalDuration = getTotalShiftDuration(
    weekOneShifts,
    breakDurationMins,
  );
  const weekTwoTotalDuration = getTotalShiftDuration(
    weekTwoShifts,
    breakDurationMins,
  );

  return {
    weekOneTotalDuration,
    weekTwoTotalDuration,
  };
};

export const getOvertimeHoursWeekly = (
  shifts: Shift[],
  overtimeBoundaryMins: number,
  breakDurationMins: number,
  paycycleStartDate: Temporal.PlainDate,
  timezone: Temporal.TimeZoneLike,
) => {
  const { weekTwoTotalDuration, weekOneTotalDuration } = getWeeklyStats(
    shifts,
    breakDurationMins,
    paycycleStartDate,
    timezone,
  );

  const weekOneOvertime = clampDuration(
    weekOneTotalDuration.subtract({
      // overtimeBoundaryMins is measured per week, breakDeduction per shift
      minutes: overtimeBoundaryMins,
    }),
  );
  const weekTwoOvertime = clampDuration(
    weekTwoTotalDuration.subtract({
      minutes: overtimeBoundaryMins,
    }),
  );

  //add week 1 OT and week 2 OT
  return weekOneOvertime.add(weekTwoOvertime);
};

export const getOvertimeHoursDaily = (
  shifts: Shift[],
  overtimeBoundaryMins: number,
  breakDuration: Temporal.Duration,
) => {
  const overtimeBoundary = Temporal.Duration.from({
    minutes: overtimeBoundaryMins,
  });
  let totalOvertime = Temporal.Duration.from({
    seconds: 0,
  });

  for (const shift of shifts) {
    const shiftOvertime = shift.endTime
      ? Temporal.Instant.from(shift.endTime)
          .since(shift.startTime)
          .subtract(breakDuration)
          .subtract(overtimeBoundary)
          .round("seconds")
          .total({ unit: "second" })
      : 0;

    totalOvertime = totalOvertime.add({
      seconds: clamp(0, shiftOvertime),
    });
  }

  return totalOvertime;
};

export const longFormDuration = (duration: Temporal.Duration) => {
  const balancedDuration = duration.round({
    largestUnit: "hours",
    smallestUnit: "seconds",
  });

  let formattedDuration = "";
  if (balancedDuration.hours > 0) {
    formattedDuration += `${balancedDuration.hours.toString()}H `;
  }
  if (balancedDuration.minutes > 0) {
    formattedDuration += `${balancedDuration.minutes.toString()}M `;
  }
  if (balancedDuration.seconds > 0 || formattedDuration.length === 0) {
    formattedDuration += `${balancedDuration.seconds.toString()}S `;
  }
  return formattedDuration.trimEnd();
};

export const filterOngoingShift = (shift: Shift) => !filterCompleteShift(shift);

export const filterCompleteShift = (shift: Shift): shift is CompleteShift =>
  shift.endTime !== null;
