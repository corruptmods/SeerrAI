import { useUser } from '@app/hooks/useUser';
import type { NavItem } from '@server/constants/navigation';
import { createContext, useContext, useMemo, useState } from 'react';

/*
 * The menu editor. Only someone arranging their menu needs it, and it brings
 * the drag-and-drop library with it, so it loads when they start customizing
 * their home page (with Discover's own editor), not with every page.
 */
export const loadNavEditor = () =>
  import('@app/components/Layout/NavEditor').then((module) => module.default);

/** A menu arrangement being edited: every item in order, and those hidden. */
export interface NavDraft {
  order: NavItem[];
  hidden: NavItem[];
}

interface NavLayoutContextValue {
  /**
   * The arrangement being edited while someone customizes their home page
   * (Discover's pencil button); undefined the rest of the time. The sidebar
   * and the phone menu show their editors while it is set.
   */
  draft?: NavDraft;
  setDraft: (draft: NavDraft | undefined) => void;
}

const NavLayoutContext = createContext<NavLayoutContextValue>({
  setDraft: () => undefined,
});

export const NavLayoutProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [draft, setDraft] = useState<NavDraft>();
  const value = useMemo(() => ({ draft, setDraft }), [draft]);
  return (
    <NavLayoutContext.Provider value={value}>
      {children}
    </NavLayoutContext.Provider>
  );
};

/**
 * The menu arrangement in effect: the one being edited, or the signed-in
 * person's own (empty lists for the usual order with everything shown).
 */
export const useNavLayout = () => {
  const { draft, setDraft } = useContext(NavLayoutContext);
  const { user } = useUser();
  const saved = useMemo(
    () => ({
      order: user?.settings?.sidebarOrder ?? [],
      hidden: user?.settings?.sidebarHidden ?? [],
    }),
    [user?.settings?.sidebarOrder, user?.settings?.sidebarHidden]
  );
  return {
    saved,
    draft,
    setDraft,
    order: draft?.order ?? saved.order,
    hidden: draft?.hidden ?? saved.hidden,
  };
};
