import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';

interface PlayButtonProps {
  links: PlayButtonLink[];
}

export interface PlayButtonLink {
  text: string;
  url: string;
  svg: React.ReactNode;
  /** Opens it in the page instead; the link still works in a new tab. */
  onOpen?: () => void;
}

/** A click that opens in the page, unless it asks for a new tab or window. */
const openHere =
  (link: PlayButtonLink) => (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      !link.onOpen ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    e.preventDefault();
    link.onOpen();
  };

const PlayButton = ({ links }: PlayButtonProps) => {
  if (!links || !links.length) {
    return null;
  }

  return (
    <ButtonWithDropdown
      as="a"
      buttonType="ghost"
      text={
        <>
          {links[0].svg}
          <span>{links[0].text}</span>
        </>
      }
      href={links[0].url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={openHere(links[0])}
    >
      {links.length > 1 &&
        links.slice(1).map((link, i) => {
          return (
            <ButtonWithDropdown.Item
              key={`play-button-dropdown-item-${i}`}
              buttonType="ghost"
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={openHere(link)}
            >
              {link.svg}
              <span>{link.text}</span>
            </ButtonWithDropdown.Item>
          );
        })}
    </ButtonWithDropdown>
  );
};

export default PlayButton;
