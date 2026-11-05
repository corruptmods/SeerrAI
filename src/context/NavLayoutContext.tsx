import { useUser } from '@app/hooks/useUser';
import type { NavItem } from '@server/constants/navigation';
import { createContext, useContext, useMemo, useState } from 'react';

/*
 * The menu editor, lazy-loaded with Discover's editor since it pulls in the
 * drag-and-drop library.
 */
export const loadNavEditor = () =>
  import('@app/components/Layout/NavEditor').then((module) => module.default);

/** A menu arrangement being edited: all items in order, and the hidden ones. */
export interface NavDraft {
  order: NavItem[];
  hidden: NavItem[];
}

interface NavLayoutContextValue {
  /**
   * The arrangement being edited (Discover's pencil button), else undefined.
   * While set, the sidebar and phone menu show their editors.
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

/** The active menu arrangement: the draft, else the user's (empty lists mean default). */
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
