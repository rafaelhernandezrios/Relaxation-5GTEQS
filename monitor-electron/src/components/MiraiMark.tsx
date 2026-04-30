import type { CSSProperties } from "react";

type MiraiMarkProps = {
  /** Width in px (logo scales proportionally). Default 56. */
  size?: number;
  /** Logo color. Default brand cyan. */
  color?: string;
  /** Whether to render the MIRAI / INNOVATION word-mark below the brain. */
  withWordmark?: boolean;
  /** Extra inline styles (positioning, opacity, etc.). */
  style?: CSSProperties;
  /** Optional className to hook into existing CSS rules. */
  className?: string;
  /** Override the accessible label. */
  ariaLabel?: string;
};

/**
 * Mirai Innovation logo. Inline SVG so it ships with the bundle, scales
 * cleanly for any density, and can be recoloured per surface (operator
 * header vs. exhibition chrome) without juggling separate PNG assets.
 */
export function MiraiMark({
  size = 56,
  color = "#1BA3C9",
  withWordmark = true,
  style,
  className,
  ariaLabel = "Mirai Innovation",
}: MiraiMarkProps) {
  const viewH = withWordmark ? 280 : 200;
  const w = size;
  const h = (size * viewH) / 240;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 240 ${viewH}`}
      width={w}
      height={h}
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={style}
    >
      <g stroke={color} strokeWidth={2.5} fill="none" strokeLinecap="round">
        <line x1="80" y1="40" x2="125" y2="35" />
        <line x1="125" y1="35" x2="170" y2="50" />
        <line x1="80" y1="40" x2="55" y2="80" />
        <line x1="170" y1="50" x2="200" y2="85" />
        <line x1="55" y1="80" x2="90" y2="92" />
        <line x1="90" y1="92" x2="125" y2="85" />
        <line x1="125" y1="85" x2="160" y2="100" />
        <line x1="160" y1="100" x2="200" y2="85" />
        <line x1="125" y1="35" x2="125" y2="85" />
        <line x1="80" y1="40" x2="90" y2="92" />
        <line x1="170" y1="50" x2="160" y2="100" />
        <line x1="90" y1="92" x2="80" y2="138" />
        <line x1="125" y1="85" x2="115" y2="138" />
        <line x1="160" y1="100" x2="170" y2="142" />
        <line x1="80" y1="138" x2="115" y2="138" />
        <line x1="115" y1="138" x2="170" y2="142" />
        <line x1="80" y1="138" x2="100" y2="172" />
        <line x1="170" y1="142" x2="150" y2="172" />
        <line x1="100" y1="172" x2="150" y2="172" />
        <line x1="115" y1="138" x2="100" y2="172" />
        <line x1="115" y1="138" x2="150" y2="172" />
      </g>
      <g fill={color} stroke="#FFFFFF" strokeWidth={2.5}>
        <circle cx={80} cy={40} r={13} />
        <circle cx={125} cy={35} r={9} />
        <circle cx={170} cy={50} r={14} />
        <circle cx={55} cy={80} r={11} />
        <circle cx={90} cy={92} r={8} />
        <circle cx={125} cy={85} r={16} />
        <circle cx={160} cy={100} r={9} />
        <circle cx={200} cy={85} r={11} />
        <circle cx={80} cy={138} r={10} />
        <circle cx={115} cy={138} r={11} />
        <circle cx={170} cy={142} r={12} />
        <circle cx={100} cy={172} r={9} />
        <circle cx={150} cy={172} r={10} />
      </g>
      {withWordmark && (
        <>
          <text
            x={120}
            y={228}
            textAnchor="middle"
            fontFamily='-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
            fontSize={46}
            fontWeight={700}
            letterSpacing={3}
            fill={color}
          >
            MIRAI
          </text>
          <text
            x={120}
            y={256}
            textAnchor="middle"
            fontFamily='-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
            fontSize={13}
            fontWeight={500}
            letterSpacing={9}
            fill={color}
          >
            INNOVATION
          </text>
        </>
      )}
    </svg>
  );
}
