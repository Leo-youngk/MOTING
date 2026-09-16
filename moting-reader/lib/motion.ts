/** 零依赖的一维阻尼弹簧插值，翻页回弹和进书展开动效共用。 */
export interface SpringOptions {
  from: number;
  to: number;
  /** 起始速度，单位「数值/秒」——松手瞬间的手指速度能带进来，弹簧才不会显得生硬。 */
  velocity?: number;
  /** 越大弹得越快。 */
  stiffness?: number;
  /** 越大越不容易过冲；配合下面默认的 stiffness 选了一组临界阻尼附近的值，回弹一次就稳，不会来回震。 */
  damping?: number;
  /** 数值和速度都小于这个阈值时判定为到位，停止动画。 */
  restThreshold?: number;
  onDone?: () => void;
}

/** 逐帧胡克弹簧数值积分，update 每帧拿到当前值，返回值是取消函数。 */
export function springTo(
  update: (value: number) => void,
  opts: SpringOptions
): () => void {
  const {
    from,
    to,
    velocity = 0,
    stiffness = 300,
    damping = 28,
    restThreshold = 0.5,
    onDone,
  } = opts;

  let value = from;
  let v = velocity;
  let last = performance.now();
  let frame = 0;
  let cancelled = false;

  const step = (now: number) => {
    if (cancelled) return;
    const dt = Math.min(1 / 30, Math.max(0, (now - last) / 1000));
    last = now;

    const displacement = value - to;
    const springForce = -stiffness * displacement;
    const dampingForce = -damping * v;
    const acceleration = springForce + dampingForce;
    v += acceleration * dt;
    value += v * dt;

    if (Math.abs(value - to) < restThreshold && Math.abs(v) < restThreshold) {
      update(to);
      onDone?.();
      return;
    }
    update(value);
    frame = requestAnimationFrame(step);
  };

  frame = requestAnimationFrame(step);

  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
