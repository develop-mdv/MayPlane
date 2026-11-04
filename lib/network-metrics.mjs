// Counter deltas are meaningful only for consecutive samples from the same boot.
/**
 * @param {Array<{at: string, networkRx?: number | null, networkTx?: number | null, uptime?: number | null}>} history
 * @returns {Array<{rx: number | null, tx: number | null}>}
 */
export function networkRates(history) {
  return history.slice(1).map((sample, index) => {
    const previous = history[index];
    const seconds =
      (new Date(sample.at).getTime() - new Date(previous.at).getTime()) / 1000;
    const rate = (name) =>
      seconds > 0 &&
      !(
        Number.isFinite(sample.uptime) &&
        Number.isFinite(previous.uptime) &&
        sample.uptime < previous.uptime
      ) &&
      Number.isFinite(sample[name]) &&
      Number.isFinite(previous[name]) &&
      sample[name] >= previous[name]
        ? (sample[name] - previous[name]) / seconds / 1024
        : null;
    return { rx: rate('networkRx'), tx: rate('networkTx') };
  });
}
