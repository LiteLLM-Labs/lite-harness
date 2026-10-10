// Canvas port of the approved Lens AgentSwarmField and DeepSpaceBackdrop.
// The original deterministic golden-angle, drift, packet and worker formulas
// are retained. Decorative stars/workers never represent real agent counts.
const TAU = Math.PI * 2;
const HUB = { x: 963, y: 562 };
const COLORS = ['#b6d8e5', '#c1b4e4', '#decba5', '#b6d4ca'];
const SEEDS = Array.from({ length: 740 }, (_, index) => ({
  index,
  angle: index * 2.39996323,
  radius: Math.sqrt((index + 0.5) / 740),
  depth: 0.5 + 0.5 * Math.sin(index * 1.371),
  bright: index % 17 === 0,
  color: index % 19 === 0 ? '#f8d797' : index % 6 === 0 ? '#d4cbff' : '#d7f0ff',
}));

export function layoutAgents(agents) {
  const points = [
    { x: 485, y: 667 }, { x: 1435, y: 667 },
    { x: 740, y: 864 }, { x: 1180, y: 864 },
  ];
  return agents.map((agent, index) => ({
    ...agent,
    ...(agents.length <= 4 ? points[index] : {
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
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.draw(132);
  }

  update(agents, selectedId, active) {
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
    const depth = context.createRadialGradient(970, 773, 0, 970, 773, 980);
    depth.addColorStop(0, '#26466a33');
    depth.addColorStop(1, '#07132100');
    context.globalAlpha = 1;
    context.fillStyle = depth;
    context.fillRect(0, 0, 1920, 1080);
    this.drawStars(frame);
    this.agents.forEach((agent, index) => this.drawAgent(agent, index, frame));
    this.drawDependencies(frame);
    context.globalAlpha = 1;
  }

  drawStars(frame) {
    const context = this.context;
    SEEDS.forEach(({ index, angle, radius, depth, bright, color }) => {
      const theta = angle + frame * 0.0014;
      const x = 960 + Math.cos(theta) * 920 * radius + Math.sin(index * 0.21 + frame * 0.014) * (7 + depth * 8);
      const y = 738 + Math.sin(theta) * 355 * radius + Math.cos(index * 0.17 + frame * 0.011) * 25;
      const size = bright ? 2.8 + depth : 0.75 + depth * 1.35;
      const flicker = 0.55 + 0.45 * Math.sin(frame / 24 + index) ** 2;
      const opacity = (bright ? 0.9 : 0.25 + depth * 0.55) * flicker * 0.55;
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
    const working = this.active && agent.status === 'running';
    const dimmed = this.selectedId && agent.id !== this.selectedId;
    const opacity = dimmed ? 0.2 : working ? 0.8 : agent.status === 'queued' ? 0.32 : 0.5;
    const color = working ? '#e2cda5' : agent.color;
    const shift = {
      x: agent.x + Math.sin(frame / 38 + index * 2) * 8,
      y: agent.y + Math.cos(frame / 43 + index) * 7,
    };
    const bend = index % 2 ? 38 : -38;
    context.globalAlpha = opacity * 0.4;
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(agent.x, agent.y);
    context.quadraticCurveTo((agent.x + HUB.x) / 2 + bend, (agent.y + HUB.y) / 2, HUB.x, HUB.y);
    context.stroke();
    for (let worker = 0; worker < 19; worker += 1) {
      const angle = worker * 2.39996 + Math.sin(frame / 45 + index) * 0.11;
      const radius = 71 + Math.sqrt(worker) * 10;
      const x = shift.x + Math.cos(angle) * radius;
      const y = shift.y + Math.sin(angle) * radius * 0.77;
      const processing = working && (Math.floor(frame / 6) + worker + index * 3) % 13 < 3;
      if (processing) {
        this.dot(x, y, 20, color, opacity * 0.035);
        this.dot(x, y, 10, color, opacity * 0.065);
      }
      this.dot(x, y, processing ? 3.5 : 2, processing ? '#fff5d5' : '#adc8e2', opacity * (processing ? 1 : 0.5));
    }
    if (!working) return;
    for (let packet = 0; packet < 4; packet += 1) {
      const progress = (frame * 0.009 + packet * 0.25 + index * 0.17) % 1;
      const position = between(agent, HUB, progress, index % 2 ? 22 : -22);
      const alpha = Math.sin(progress * Math.PI) * opacity;
      this.dot(position.x, position.y, 13, color, alpha * 0.08);
      context.globalAlpha = alpha;
      context.fillStyle = color;
      context.fillRect(position.x - 3, position.y - 3, 6, 6);
    }
    for (let packet = 0; packet < 8; packet += 1) {
      const start = { x: index % 2 ? 2040 : -120, y: 460 + ((packet * 137 + index * 93) % 610) };
      const progress = (frame * 0.002 + packet / 8 + index * 0.19) % 1;
      const position = between(start, shift, progress, Math.sin(index) * 80);
      context.globalAlpha = Math.sin(progress * Math.PI) * 0.3 * opacity;
      context.fillStyle = index % 2 ? '#8392bd' : '#7bb9c9';
      context.fillRect(position.x, position.y, progress > 0.8 ? 4 : 9, 2);
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
