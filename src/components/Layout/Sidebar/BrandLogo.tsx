import Image from 'next/image';

/**
 * The Seerr logo with "AI" as live text in the mark's gradient, sharp at any
 * size. The wordmark is white, so light mode uses the dark one.
 */
const BrandLogo = ({ eager = false }: { eager?: boolean }) => (
  <>
    <span className="hidden h-full items-center gap-2 dark:flex">
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
    <span className="relative block h-full w-56 flex-none dark:hidden">
      <Image
        src="/logo_ai_light.svg"
        alt="Seerr AI"
        fill
        loading={eager ? 'eager' : undefined}
      />
    </span>
  </>
);

/** The sign-in and setup pages' stacked logo, filling its box, per theme. */
export const StackedLogo = () => (
  <>
    <Image
      src="/logo_stacked_ai.svg"
      alt="Seerr AI"
      fill
      className="hidden dark:block"
    />
    <Image
      src="/logo_stacked_ai_light.svg"
      alt="Seerr AI"
      fill
      className="dark:hidden"
    />
  </>
);

export default BrandLogo;
