import Image from 'next/image';

interface LogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  variant?: 'full' | 'icon';
  className?: string;
  priority?: boolean;
}

const SIZES = {
  sm: { width: 32, height: 32 },
  md: { width: 44, height: 44 },
  lg: { width: 64, height: 64 },
  xl: { width: 380, height: 260 },
};

export function Logo({ size = 'md', variant = 'icon', className = '', priority = false }: LogoProps) {
  const dims = SIZES[size];
  const src = variant === 'full' ? '/logo.png' : '/logo-icon.png';

  return (
    <Image
      src={src}
      alt="SharkAI"
      width={dims.width}
      height={dims.height}
      className={`object-contain ${className}`}
      priority={priority}
    />
  );
}
