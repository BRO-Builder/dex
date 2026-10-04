export function AnimatedLogo() {
  return (
    <svg
      className="cn-logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -80 400 480"
      width="100"
      height="100"
      role="img"
      aria-label="BRO Builder"
    >
      <path fill="#FFFFFF" d="M221,354 H233 V392 H167 V378 H221 Z" />
      <path fill="#FFFFFF" d="M221,310 H233 V348 H167 V334 H221 Z" />
      <path fill="#FFFFFF" d="M75.8,195 H148 A52.8,52.8 0 0 0 251.2,195 H323.4 A124.6,124.6 0 0 1 75.8,195 Z" />
      <path
        fill="#FFFFFF"
        d="M274.5,35.4 H287.5 V38 H283 V53 H279.6 V38 H274.5 Z M290.5,53 V35.4 H294.8 L300.2,45.2 L305.6,35.4 H309.5 V53 H306 V41.5 L300.2,51 L294,41.5 V53 Z"
      />
      <path
        className="cn-hat"
        fill="#FF9B00"
        d="M64,182.5 Q200.5,206 337,182.5 C338.8,181.5 339,177 339,172 C339,157 329.5,145 322,141 V140 A121.5,110 0 0 0 250.5,39.7 L228.5,79 V23 A11,11 0 0 0 217.5,12 H183.5 A10.5,10.5 0 0 0 173,23 V79 L150.5,39.7 A121.5,110 0 0 0 79,140 V141 C71.5,145 62,157 62,172 C62,177 62.2,181.5 64,182.5 Z"
      />
      {[
        { cx: 146, cy: 22, delay: "0s" },
        { cx: 200, cy: -8, delay: "0.8s" },
        { cx: 254, cy: 22, delay: "1.6s" },
      ].map((coin) => (
        <g className="cn-coin" style={{ animationDelay: coin.delay }} key={`${coin.cx}-${coin.cy}`}>
          <circle cx={coin.cx} cy={coin.cy} r="20" fill="#F5BF23" stroke="#BA7517" strokeWidth="4" />
          <circle cx={coin.cx} cy={coin.cy} r="13" fill="none" stroke="#BA7517" strokeWidth="2" />
          <path
            d={`M${coin.cx - 11},${coin.cy - 4} A11,11 0 0 1 ${coin.cx - 4},${coin.cy - 11}`}
            fill="none"
            stroke="#fff"
            strokeWidth="3"
            strokeLinecap="round"
            opacity=".7"
          />
        </g>
      ))}
    </svg>
  );
}
