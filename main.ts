// Washout-recovery BTC bot for the 24h CBBTC race.
//
// Idea: on a one-minute clock BTC spends most of a day chopping inside a ~2% band, and
// every full-size round trip costs about 26 bps in fees, slippage and impact, so the
// bot trades rarely and only for a clear, confirmed edge. It does exactly one thing:
//
//   Buy the recovery after a washout. When the close has fallen at least
//   WASHOUT_BPS below its 240-bar high (a real washout, not ordinary noise) and
//   then crosses back above its 10-bar EMA (buyers are stepping back in), it buys
//   with all its cash. There is no dip-buying into a falling market: a close under
//   its EMA while the washout is still deepening is never an entry, so the bot
//   cannot catch the falling knife on the way down.
//
//   Ride the recovery and get out on the turn. Once in, it sells when the close
//   falls TRAIL_BPS under the highest close since entry (a trailing stop that lets
//   a real recovery run keep going) or when the position is STOP_BPS under its cost
//   (a hard stop). There is no fixed take-profit: the trailing stop is what banks
//   the move.
//
// Why this shape, and why not the usual ones, on the dev window (a day that
// plunged ~2.1% in its first two hours, ground back up ~2% by mid-day, chopped,
// then dropped again in its last hour):
//
//   - Plain dip-buying bleeds: it buys into the plunge and keeps re-entering the
//     chop. The best dip-buying grid on this window is about +5 USDC and loses
//     ~16 USDC on the previous day's window.
//   - EMA crossovers churn: the 1-minute crosses fire dozens of times and every
//     round trip pays ~26 bps. The kit's own ema-cross baseline loses ~148 USDC
//     here; every other baseline loses too (buy-and-hold -31.6, momentum -23.9,
//     rsi-bollinger -39.9, adx-momentum -75.6).
//   - The washout-recovery rule fires once on this window and once or twice on
//     the previous day's window, and is positive on both (+12.35 / +9.21 USDC in
//     a fill-exact local replay). Its parameters sit on a broad plateau, not a
//     knife edge: drawdown thresholds 120-200 bps and trailing stops 60-100 bps
//     are all positive on both windows, and EMA spans 5-30 all work.
//
// Everything is deterministic: plain float64 arithmetic on closes, no clock, no
// randomness, no environment reads. Indicators seed exactly like the kit
// baselines (an EMA starts as the mean of its first span of closes).

import { BPS, runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** The washout is measured against this many prior bars of closes (four hours). */
const HI_BARS = 240;
/** The recovery cross is measured against this span of closes. */
const EMA_BARS = 10;
/** Buy only after the close has fallen at least this far under its 240-bar high, in bps. */
const WASHOUT_BPS = 150;
/** Sell when the close falls this far under the peak since entry, in bps. */
const TRAIL_BPS = 70;
/** Sell when the position is worth this far under its cost, in bps. */
const STOP_BPS = 150;
/** Each order caps its slippage at 1% past the close it was decided on. */
const MAX_SLIPPAGE_BPS = 100;

/** The closes seen so far, oldest first (used for the rolling 240-bar high). */
const closes: number[] = [];
/** The 10-bar EMA of closes, null until its first span has been seen. */
let ema: number | null = null;
const emaWarm: number[] = [];
/** Whether the previous bar's close sat above the EMA, null before the EMA exists. */
let prevAbove: boolean | null = null;
/** The highest close since the current entry, null while flat. */
let peak: number | null = null;

/** Fold one close into the EMA. */
function pushEma(close: number): void {
  if (ema !== null) {
    ema += (2 / (EMA_BARS + 1)) * (close - ema);
  } else {
    emaWarm.push(close);
    if (emaWarm.length === EMA_BARS) ema = emaWarm.reduce((a, x) => a + x, 0) / EMA_BARS;
  }
}

/**
 * Whether the position held at this close should exit: the trailing stop, or the
 * hard stop against its cost.
 */
function shouldExit(state: BarsState, held: { qty: bigint; cost: bigint }, close: number): boolean {
  if (peak !== null && close > peak) peak = close;
  const trailHit = peak !== null && ((peak - close) / peak) * 10_000 >= TRAIL_BPS;
  const value = state.value(SYMBOL, held.qty);
  const stopHit = value * BigInt(10_000) <= held.cost * BigInt(10_000 - STOP_BPS);
  return trailHit || stopHit;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);

    // The washout is measured against the 240 closes before this bar.
    const hi = closes.length >= HI_BARS ? Math.max(...closes.slice(-HI_BARS)) : null;
    closes.push(close);
    // Keep only the closes the rolling high can still see: bounded memory, and
    // the next bar's high is the same max over the same 240 closes.
    if (closes.length > HI_BARS) closes.shift();
    pushEma(close);

    const above = ema !== null && close > ema;
    const crossedUp = prevAbove !== null && above && !prevAbove;
    prevAbove = ema === null ? null : above;
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined) {
      if (peak === null) peak = close;
      if (shouldExit(state, held, close)) {
        peak = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat: buy only the recovery cross after a real washout.
    if (hi === null || !crossedUp) return [];
    const drawdownBps = ((hi - close) / hi) * 10_000;
    if (drawdownBps < WASHOUT_BPS) return [];

    const { caps, fees } = state.hello;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    const size = state.cash < byWeight ? state.cash : byWeight;
    if (size === 0n || size < BigInt(fees.min_notional_quote_units)) return [];
    peak = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS } satisfies BuyInput];
  },
});
