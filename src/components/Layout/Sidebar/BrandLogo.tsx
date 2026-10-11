import Image from 'next/image';

/**
 * The Seerr logo with "AI" beside it, in the logo mark's own gradient. The
 * logo file is left as it is; "AI" is live text, so it stays sharp at any
 * size.
 */
const BrandLogo = ({ eager = false }: { eager?: boolean }) => (
  <span className="flex h-full items-center gap-2">
    <span className="relative block h-full w-44 flex-none">
      <Image
        src="/logo_full.svg"
        alt="Seerr AI"
        fill
        loading={eager ? 'eager' : undefined}
      />
    </span>
    <span className="bg-gradient-to-br from-[#C395FC] to-[#4F65F5] bg-clip-text text-3xl font-extrabold leading-none tracking-tight text-transparent">
      AI
    </span>
  </span>
);

export default BrandLogo;
