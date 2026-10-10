// Preserve the original Lens positions for small swarms; larger teams get
// measured, staggered rows with room for every clickable logo and status.
const ORIGINAL_POSITIONS = [[.18,.44],[.35,.59],[.65,.56],[.86,.44],[.08,.68],[.245,.80],[.435,.77],[.61,.82],[.80,.78],[.93,.66]];

export function brainLayout(count, width, height) {
  const mobile = width < 650;
  if (count <= 10) {
    return {
      height: null,
      hubY: height * (mobile ? .18 : .32),
      points: Array.from({length: count}, (_, index) => {
        const point = mobile ? [.26 + (index % 2) * .49, .29 + Math.floor(index / 2) * .135 + (index % 2) * .025] : ORIGINAL_POSITIONS[index];
        return {x: Math.max(78, Math.min(width - 78, point[0] * width)), y: point[1] * height};
      }),
    };
  }
  const columns = Math.max(1, Math.min(7, Math.floor(width / (mobile ? 155 : 188))));
  const rows = Math.ceil(count / columns);
  const rowHeight = mobile ? 190 : 180;
  const firstRow = mobile ? 440 : 420;
  return {
    height: firstRow + rows * rowHeight + 75,
    hubY: mobile ? 320 : 290,
    points: Array.from({length: count}, (_, index) => ({
      x: width / columns * ((index % columns) + .5),
      y: firstRow + Math.floor(index / columns) * rowHeight + (index % 2) * 26,
    })),
  };
}

export function resizeTeam(team, count, defaults) {
  const next = team.slice(0, count).map((agent) => ({...agent}));
  const ids = new Set(next.map((agent) => agent.id));
  let number = Math.max(0, ...team.map((agent) => Number(agent.id.match(/^peer-(\d+)$/)?.[1]) || 0)) + 1;
  while (next.length < count) {
    const template = defaults[next.length % defaults.length];
    if (!template) throw new Error('The default team is still loading.');
    while (ids.has(`peer-${String(number).padStart(2, '0')}`)) number += 1;
    const suffix = String(number++).padStart(2, '0');
    const agent = {...template, id: `peer-${suffix}`, name: `Agent ${suffix}`, status: 'queued'};
    ids.add(agent.id);
    next.push(agent);
  }
  return next;
}
