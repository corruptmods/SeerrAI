import siloIcon from '@app/assets/services/silo.png';

/**
 * Silo's official, unmodified icon (from Silo's assets/icon.png), shown only
 * as Silo's server-type mark, sized like the other servers' logos.
 */
const SiloLogo = ({ className }: React.SVGProps<SVGSVGElement>) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img
    src={typeof siloIcon === 'string' ? siloIcon : siloIcon.src}
    alt=""
    aria-hidden="true"
    className={className}
  />
);

export default SiloLogo;
