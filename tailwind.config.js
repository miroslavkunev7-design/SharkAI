/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-space)', 'system-ui', 'sans-serif'],
      },
      colors: {
        shark: {
          black: '#000000',
          navy: '#0a0e1a',
          deep: '#0d1225',
          cyan: '#00D2FF',
          blue: '#0072FF',
          purple: '#9D50BB',
          violet: '#6E48AA',
        },
      },
      backgroundImage: {
        'shark-gradient': 'linear-gradient(135deg, #00D2FF 0%, #0072FF 50%, #9D50BB 100%)',
        'shark-gradient-h': 'linear-gradient(90deg, #00D2FF 0%, #0072FF 50%, #9D50BB 100%)',
        'hero-glow': 'radial-gradient(ellipse at 50% 0%, rgba(0,114,255,0.15) 0%, transparent 70%)',
      },
      animation: {
        'pulse-glow': 'pulse-glow 3s ease-in-out infinite',
        float: 'float 6s ease-in-out infinite',
        circuit: 'circuit 20s linear infinite',
      },
      keyframes: {
        'pulse-glow': {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        circuit: {
          '0%': { strokeDashoffset: '1000' },
          '100%': { strokeDashoffset: '0' },
        },
      },
      boxShadow: {
        glow: '0 0 40px rgba(0, 210, 255, 0.3)',
        'glow-purple': '0 0 40px rgba(157, 80, 187, 0.3)',
        glass: '0 8px 32px rgba(0, 0, 0, 0.4)',
      },
    },
  },
  plugins: [],
};
