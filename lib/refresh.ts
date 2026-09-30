/**
 * Keeps stored signals in sync with live Polymarket data:
 * current prices, volume/liquidity, images and resolution status.
 */
import {fetchEventById, outcomePrice} from './polymarket';
import {applyMarketUpdate, getMarketOutcomes, getSignalEventIds} from './repo';

export interface RefreshResult {
  events: number;
  updated: number;
  errors: string[];
}

/** Refreshes every event that has at least one stored signal. */
export async function refreshSignals(): Promise<RefreshResult> {
  const eventIds = getSignalEventIds();
  const errors: string[] = [];
  let updated = 0;

  for (const eventId of eventIds) {
    try {
      const event = await fetchEventById(eventId);
      if (!event) continue;

      const prices = new Map<string, number>();
      const finalPrices = new Map<string, number>();
      let resolved = true;

      const stored = getMarketOutcomes(eventId);
      for (const {market_id, outcome, status} of stored) {
        const price = outcomePrice(event, market_id, outcome);
        if (price === null) continue;
        prices.set(`${market_id}|${outcome}`, price);
        // outcomePrices of a resolved market are exactly 0 or 1
        const isFinal = price <= 0.001 || price >= 0.999;
        if (isFinal && status === 'pending') {
          finalPrices.set(`${market_id}|${outcome}`, price);
        }
        if (!isFinal) resolved = false;
      }
      if (!resolved) finalPrices.clear();

      updated += applyMarketUpdate(eventId, {
        volume: event.volume,
        liquidity: event.liquidity,
        image: event.image,
        prices,
        finalPrices
      });
    } catch (error) {
      errors.push(`${eventId}: ${(error as Error).message}`);
      console.error('[refresh] event %s: %s', eventId, (error as Error).message);
    }
  }

  return {events: eventIds.length, updated, errors};
}
