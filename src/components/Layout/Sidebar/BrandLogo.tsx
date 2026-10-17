import Image from 'next/image';

/**
 * The Seerr logo with "AI" beside it, in the logo mark's own gradient. The
 * logo file is left as it is; "AI" is live text, so it stays sharp at any
 * size. Its wordmark is white, so light mode has the dark one, with "AI".
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

/**
 * The stacked logo of the sign-in and setup pages, filling the box it is
 * put in: the white wordmark on a dark page, the dark one on a light page.
 */
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
