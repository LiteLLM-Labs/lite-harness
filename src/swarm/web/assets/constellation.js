// Canvas port of the approved Lens AgentSwarmField and DeepSpaceBackdrop.
// The original deterministic golden-angle, drift, packet and worker formulas
// are retained. Decorative stars/workers never represent real agent counts.
const TAU = Math.PI * 2;
const HUB = { x: 963, y: 562 };
const COLORS = ['#8fd9e5', '#b0a6ee', '#b6d8e5', '#b6d4ca'];
const makeSeeds = (count) => Array.from({ length: count }, (_, index) => ({
  index,
  angle: index * 2.39996323,
  radius: Math.sqrt((index + 0.5) / count),
  depth: 0.5 + 0.5 * Math.sin(index * 1.371),
  bright: index % 17 === 0,
  color: index % 19 === 0 ? '#f8d797' : index % 6 === 0 ? '#d4cbff' : '#d7f0ff',
}));
const SEEDS = makeSeeds(740);
const BACKDROP = makeSeeds(880);

export function layoutAgents(agents) {
  const points = [
    { x: 485, y: 667 }, { x: 1435, y: 667 },
    { x: 740, y: 864 }, { x: 1180, y: 864 },
  ];
  return agents.map((agent, index) => ({
    ...agent,
    ...(Number.isFinite(agent.x) && Number.isFinite(agent.y) ? { x: agent.x, y: agent.y } : agents.length <= 4 ? points[index] : {
      x: 960 + Math.cos((index / agents.length) * TAU - Math.PI / 2) * 600,
      y: 725 + Math.sin((index / agents.length) * TAU - Math.PI / 2) * 200,
    }),
    color: COLORS[index % COLORS.length],
  }));
}

function between(source, target, progress, bend = 0) {
  return {
    x: source.x + (target.x - source.x) * progress + Math.sin(progress * Math.PI) * bend,
    y: source.y + (target.y - source.y) * progress,
  };
}

export class Constellation {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.agents = [];
    this.selectedId = null;
    this.active = false;
    this.hub = HUB;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    this.startedAt = performance.now();
    this.lastFrame = 0;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.reducedMotion.addEventListener('change', () => this.draw(132));
    this.resize();
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    // Keep long, scrollable swarms below browser canvas dimension limits.
    const ratio = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(1, rect.height, rect.width));
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.draw(132);
  }

  update(agents, selectedId, active, hub = HUB) {
    this.hub = hub;
    this.agents = layoutAgents(agents);
    this.selectedId = selectedId;
    this.active = active;
    if (this.reducedMotion.matches) this.draw(132);
  }

  animate(now) {
    if (!document.hidden && !this.reducedMotion.matches && now - this.lastFrame >= 33) {
      this.draw(132 + (now - this.startedAt) * 0.03);
      this.lastFrame = now;
    }
    requestAnimationFrame(this.animate);
  }

  dot(x, y, radius, color, opacity = 1) {
    const context = this.context;
    context.globalAlpha = opacity;
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fill();
  }

  draw(frame) {
    const context = this.context;
    if (!context || !this.canvas.width || !this.canvas.height) return;
    context.setTransform(this.canvas.width / 1920, 0, 0, this.canvas.height / 1080, 0, 0);
    context.clearRect(0, 0, 1920, 1080);
    context.globalAlpha = 1;
    this.drawDepth(970, 773, 980, 570, '#26466a38');
    this.drawDepth(this.hub.x, this.hub.y, 240, 210, '#b7d4ff19');
    this.drawBackdrop(frame);
    this.drawStars(frame);
    this.drawHub(frame);
    this.agents.forEach((agent, index) => this.drawAgent(agent, index, frame));
    this.drawDependencies(frame);
    context.globalAlpha = 1;
  }

  drawDepth(x, y, width, height, color) {
    const context = this.context;
    context.save();
    context.translate(x, y);
    context.scale(width, height);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, '#07132100');
    context.fillStyle = gradient;
    context.fillRect(-1, -1, 2, 2);
    context.restore();
  }

  drawBackdrop(frame) {
    const context = this.context;
    BACKDROP.forEach(({ index, angle, radius, depth, bright, color }) => {
      const theta = angle + frame * 0.0011;
      const x = 960 + Math.cos(theta) * 1040 * radius + Math.sin(index * 0.21 + frame * 0.012) * (7 + depth * 8);
      const y = 720 + Math.sin(theta) * 490 * radius + Math.cos(index * 0.17 + frame * 0.011) * 25;
      const size = bright ? 2.8 + depth : 0.75 + depth * 1.35;
      const flicker = 0.55 + 0.45 * Math.sin(frame / 24 + index) ** 2;
      // Keep the product headline quiet; the original two fields retain their
      // exact geometry and accumulate into the dense constellation below it.
      const lowerField = Math.max(0, Math.min(1, (y - 245) / 240));
      const opacity = (bright ? 0.9 : 0.25 + depth * 0.55) * flicker * lowerField * 0.58;
      if (bright) {
        context.globalAlpha = opacity;
        const glint = context.createRadialGradient(x, y, 0, x, y, size * 13);
        glint.addColorStop(0, '#d3e8ff61');
        glint.addColorStop(0.3, '#b0d5ff13');
        glint.addColorStop(1, '#d3e8ff00');
        context.fillStyle = glint;
        context.fillRect(x - size * 13, y - size * 13, size * 26, size * 26);
        this.drawCross(x, y, size * 4, color, opacity * 0.3);
      }
      this.dot(x, y, size, color, opacity);
    });
  }

  drawCross(x, y, radius, color, opacity) {
    const context = this.context;
    context.globalAlpha = opacity;
    context.strokeStyle = color;
    context.lineWidth = 0.65;
    context.beginPath();
    context.moveTo(x - radius, y);
    context.lineTo(x + radius, y);
    context.moveTo(x, y - radius);
    context.lineTo(x, y + radius);
    context.stroke();
  }

  drawHub(frame) {
    const context = this.context;
    const pulse = 1 + Math.sin(frame / 13) * 0.065;
    context.globalAlpha = 1;
    this.drawDepth(this.hub.x, this.hub.y, 152 * pulse, 152 * pulse, '#b7d4ff19');
    // The actual logo, label and interaction belong to the DOM above this.
    context.globalAlpha = 0.22;
    context.strokeStyle = '#b4dce7';
    context.lineWidth = 0.9;
    context.beginPath();
    context.roundRect(this.hub.x - 48, this.hub.y - 48, 96, 96, 18);
    context.stroke();
  }

  drawStars(frame) {
    const context = this.context;
    SEEDS.forEach(({ index, angle, radius, depth, bright, color }) => {
      const theta = angle + frame * 0.0014;
      const x = 960 + Math.cos(theta) * 920 * radius + Math.sin(index * 0.21 + frame * 0.014) * (7 + depth * 8);
      const y = 738 + Math.sin(theta) * 355 * radius + Math.cos(index * 0.17 + frame * 0.011) * 25;
      const size = bright ? 2.8 + depth : 0.75 + depth * 1.35;
      const flicker = 0.55 + 0.45 * Math.sin(frame / 24 + index) ** 2;
      const opacity = (bright ? 0.9 : 0.25 + depth * 0.55) * flicker;
      if (bright) {
        this.dot(x, y, size * 11, color, opacity * 0.017);
        this.dot(x, y, size * 4.5, color, opacity * 0.04);
        context.globalAlpha = opacity * 0.3;
        context.strokeStyle = color;
        context.lineWidth = 0.65;
        context.beginPath();
        context.moveTo(x - size * 4, y);
        context.lineTo(x + size * 4, y);
        context.moveTo(x, y - size * 4);
        context.lineTo(x, y + size * 4);
        context.stroke();
      }
      this.dot(x, y, size, color, opacity);
    });
  }

  drawAgent(agent, index, frame) {
    const context = this.context;
    const hub = this.hub;
    const working = this.active && agent.status === 'running';
    const selected = agent.id === this.selectedId;
    const dimmed = this.selectedId && !selected;
    const opacity = dimmed ? 0.25 : working ? 0.95 : agent.status === 'queued' ? 0.45 : 0.62;
    // Warm points stay sparse, even when all ten agents are working.
    const color = working && (index % 4 === 0 || selected) ? '#ffdb94' : agent.color;
    const shift = {
      x: agent.x + Math.sin(frame / 38 + index * 2) * 8,
      y: agent.y + Math.cos(frame / 43 + index) * 7,
    };
    const bend = index % 2 ? 38 : -38;
    context.globalAlpha = opacity * 0.19;
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(shift.x, shift.y);
    context.quadraticCurveTo((shift.x + hub.x) / 2 + bend, (shift.y + hub.y) / 2, hub.x, hub.y);
    context.stroke();

    // Original Lens corner framing, now attached to the actual agent anchor.
    context.globalAlpha = opacity * 0.14;
    context.fillStyle = '#0a1c2b';
    context.beginPath();
    context.roundRect(shift.x - 82, shift.y - 65, 164, 129, 12);
    context.fill();
    context.globalAlpha = opacity * 0.12;
    context.strokeStyle = color;
    context.stroke();
    context.globalAlpha = opacity * (selected ? 0.9 : 0.5);
    context.beginPath();
    context.moveTo(shift.x - 82, shift.y - 43);
    context.lineTo(shift.x - 82, shift.y - 65);
    context.lineTo(shift.x - 60, shift.y - 65);
    context.moveTo(shift.x + 82, shift.y + 43);
    context.lineTo(shift.x + 82, shift.y + 65);
    context.lineTo(shift.x + 60, shift.y + 65);
    context.stroke();

    for (let worker = 0; worker < 19; worker += 1) {
      const angle = worker * 2.39996 + Math.sin(frame / 45 + index) * 0.11;
      // A small central clearance exposes the real harness mark in the DOM.
      const radius = 35 + Math.sqrt(worker) * 12;
      const x = shift.x + Math.cos(angle) * radius;
      const y = shift.y + Math.sin(angle) * radius * 0.77;
      const processing = working && (Math.floor(frame / 6) + worker + index * 3) % 13 < 3;
      if (processing) {
        this.dot(x, y, 20, color, opacity * 0.035);
        this.dot(x, y, 10, color, opacity * 0.065);
        context.globalAlpha = opacity * (0.55 + 0.45 * Math.sin(frame / 12 - index) ** 2) * 0.45;
        context.strokeStyle = color;
        context.lineWidth = 0.6;
        context.beginPath();
        context.moveTo(x - 9, y - 3);
        context.lineTo(x - 9, y - 9);
        context.lineTo(x - 3, y - 9);
        context.moveTo(x + 9, y + 3);
        context.lineTo(x + 9, y + 9);
        context.lineTo(x + 3, y + 9);
        context.stroke();
      }
      this.dot(x, y, processing ? 4 : 2.4, processing ? '#fff5d5' : '#adc8e2', opacity * (processing ? 1 : 0.62));
    }
    if (!working) return;
    for (let packet = 0; packet < 4; packet += 1) {
      const progress = (frame * 0.014 + packet * 0.25 + index * 0.17) % 1;
      const position = between(shift, hub, progress, index % 2 ? 22 : -22);
      const alpha = Math.sin(progress * Math.PI) * opacity;
      this.dot(position.x, position.y, 13, color, alpha * 0.075);
      context.globalAlpha = alpha;
      context.fillStyle = color;
      context.beginPath();
      context.roundRect(position.x - 3, position.y - 3, 6, 6, 1);
      context.fill();
      context.globalAlpha = alpha * 0.3;
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(position.x - 7, position.y + 11);
      context.lineTo(position.x - 3, position.y + 5);
      context.stroke();
    }
    for (let packet = 0; packet < 16; packet += 1) {
      const start = { x: index % 2 ? 2040 : -120, y: 460 + ((packet * 137 + index * 93) % 610) };
      const progress = (frame * 0.006 + packet / 16 + index * 0.19) % 1;
      const position = between(start, shift, progress, Math.sin(index) * 80);
      context.globalAlpha = Math.sin(progress * Math.PI) * 0.46 * opacity;
      context.fillStyle = index % 2 ? '#8392bd' : '#7bb9c9';
      context.beginPath();
      context.roundRect(position.x, position.y, progress > 0.8 ? 4 : 9, 3, 1);
      context.fill();
    }
  }

  drawDependencies(frame) {
    const context = this.context;
    this.agents.forEach((target, index) => {
      (target.dependsOn || []).forEach((sourceId) => {
        const source = this.agents.find((agent) => agent.id === sourceId);
        if (!source) return;
        context.globalAlpha = this.selectedId && ![target.id, source.id].includes(this.selectedId) ? 0.04 : 0.15;
        context.strokeStyle = target.color;
        context.lineWidth = 1;
        context.setLineDash([4, 10]);
        context.beginPath();
        context.moveTo(source.x, source.y);
        context.quadraticCurveTo((source.x + target.x) / 2 - 35, (source.y + target.y) / 2, target.x, target.y);
        context.stroke();
        context.setLineDash([]);
        if (target.status === 'running' && source.status === 'complete') {
          const progress = (frame * 0.004 + index * 0.21) % 1;
          const position = between(source, target, progress, -18);
          this.dot(position.x, position.y, 3, target.color, Math.sin(progress * Math.PI) * 0.6);
        }
      });
    });
  }
}
