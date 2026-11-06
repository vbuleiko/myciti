/** [lng, lat] */
export type LngLat = [number, number];

// ---------------------------------------------------------------------------
// Static network (normalised from the site's map_routes / map_stops variables)
// ---------------------------------------------------------------------------

export interface NetworkStop {
  id: string;
  name: string;
  lat: number;
  lng: number;
  routes: string[];
}

export interface NetworkDirection {
  directionId: number;
  headsign: string;
  /** Stop sequence as published (consecutive duplicates removed). */
  stopIds: string[];
  /** Route trace as [lng, lat] pairs. */
  shape: LngLat[];
}

export interface NetworkRoute {
  id: string;
  name: string;
  longName: string;
  /** "#RRGGBB" */
  color: string;
  /** "#RRGGBB" */
  textColor: string;
  directions: NetworkDirection[];
}

export interface Network {
  /** epoch ms when the source page was fetched */
  fetchedAt: number;
  routes: NetworkRoute[];
  stops: NetworkStop[];
}

// ---------------------------------------------------------------------------
// Raw timetable (normalised from the site's `var timetable`)
// ---------------------------------------------------------------------------

export interface RawStopTime {
  stopId: string;
  name: string;
  isStation: boolean;
  /** "HH:MM" as published (schedule) */
  staticTime: string;
  /** "HH:MM" as published (actual for passed stops, prediction for future ones) */
  time: string;
  /** delay == "Live" */
  live: boolean;
}

export interface RawTrip {
  tripId: string;
  startTime: string;
  /** In the order the site lists them (which is sorted by `time`, not by stop sequence!). */
  stops: RawStopTime[];
}

export interface RawDirectionTimetable {
  routeId: string;
  directionId: number;
  routeName: string;
  /** Weekday name, e.g. "Friday" */
  day: string;
  serviceAdvisory: string | null;
  trips: RawTrip[];
}

// ---------------------------------------------------------------------------
// Prepared trips (what the server sends to clients)
// ---------------------------------------------------------------------------

export interface TripStop {
  stopId: string;
  name: string;
  /** scheduled time, epoch ms */
  sched: number;
  /** published time (`time`), epoch ms, unwrapped around midnight */
  raw: number;
  /** time used for positioning: robust monotonic fit + spreading of equal times, epoch ms */
  fit: number;
  /** stop had delay == "Live" */
  live: boolean;
  /** `raw` was inconsistent with neighbours and was re-estimated in `fit` */
  outlier: boolean;
  /** metres along the direction's shape */
  dist: number;
}

export interface PreparedTrip {
  /** `${routeId}:${tripId}` */
  key: string;
  routeId: string;
  directionId: number;
  tripId: string;
  headsign: string;
  /** epoch ms when the timetable page was fetched */
  fetchedAt: number;
  /** at least one stop is "Live" */
  live: boolean;
  /** max |fit - sched| over live stops > threshold */
  suspect: boolean;
  /** max |fit - sched| over live stops, minutes */
  maxAbsDelayMin: number;
  /** in travel order */
  stops: TripStop[];
}

export type VehicleState = 'waiting' | 'moving' | 'arrived';

export interface VehicleEstimate {
  key: string;
  state: VehicleState;
  /** metres along the direction shape */
  dist: number;
  /** index of the last stop passed (or the first stop if waiting) */
  prevIdx: number;
  /** index of the next stop (== prevIdx when waiting/arrived) */
  nextIdx: number;
  /** interpolated (fit - sched) at the current position, seconds */
  delaySec: number;
}

export interface EngineOptions {
  /** show a bus waiting at the first stop this long before departure */
  preDepartureMs: number;
  /** keep showing a bus at the last stop this long after arrival */
  postArrivalMs: number;
  /** |delay| above this marks a trip as suspect */
  suspectThresholdMs: number;
  /** merge "arrived" + "waiting" at the same terminal if gap is within this */
  terminalMergeMaxGapMs: number;
  /** stops considered the same terminal if this close (metres) */
  terminalMergeMaxDistM: number;
  /**
   * Hide a bus once the snapshot it comes from is older than this (0 = never). Between
   * polls a position is a forecast from the last snapshot; after an outage the forecast is
   * fiction, so stop drawing it.
   */
  maxDataAgeMs: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  preDepartureMs: 5 * 60_000,
  postArrivalMs: 60_000,
  suspectThresholdMs: 30 * 60_000,
  terminalMergeMaxGapMs: 10 * 60_000,
  terminalMergeMaxDistM: 250,
  maxDataAgeMs: 20 * 60_000,
};
