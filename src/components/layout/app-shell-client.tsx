
'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { UserNav } from './user-nav';
import { TopNav } from './top-nav';
import { Logo } from '../logo';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '../ui/button';
import { useCurrentUser } from '@/hooks/use-current-user';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { cn } from '@/lib/utils';
import { useExternalLink } from '@/hooks/use-external-link';
import type { NavGroup } from '@/types/navigation';
import { Skeleton } from '../ui/skeleton';

const navGroups: NavGroup[] = [
  {
    title: 'Allocations',
    roles: ['admin', 'manager', 'vp'],
    items: [
      { href: '/allocation', label: 'Weekly Allocation' },
      { href: '/bulk-allocation', label: 'Bulk Allocation' },
      { href: '/monthly-freshservice-allocation', label: 'Monthly Freshservice Allocation' },
    ]
  },
  {
    title: 'Targets',
    roles: ['admin', 'manager', 'vp'],
    items: [
      { href: '/weekly-targets', label: 'Quarterly Targets' },
    ]
  },
  {
    title: 'Management',
    roles: ['admin', 'manager', 'vp'],
    items: [
      { href: '/team', label: 'Team Management' },
      { href: '/cost-centers', label: 'Client Management', roles: ['admin'] },
      { href: '/title_management', label: 'Title Management', roles: ['admin', 'manager'] },
      { href: '/hr-data-issues', label: 'HR Data Issues' },
    ]
  },
  {
    title: 'User Resources',
    roles: ['admin', 'manager', 'vp'],
    items: [
      { 
        href: 'https://docs.google.com/document/d/1EVxmQj5mRkqkt6FX90W3tRwxvlkMayuYjS52Jd-cvMc/edit?usp=sharing',
        label: 'Knowledge Base' 
      },
    ]
  }
];

const getHref = (href: string) => {
    if (!href) return '/index.html';
    if (href.startsWith('http')) return href;
    const cleanHref = typeof href === 'string' ? href : '/index.html';
    if (cleanHref === '/') return '/index.html';
    const base = cleanHref.endsWith('/') ? cleanHref : `${cleanHref}/`;
    return `${base}index.html`;
};

export function AppShellClient({ children }: { children: React.ReactNode }) {
  const { currentUser, loading } = useCurrentUser();
  const pathname = usePathname();
  const openExternalLink = useExternalLink();
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const [hasMounted, setHasMounted] = useState(false);

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const isActive = useCallback((href: string) => {
    if (!pathname) return false;
    if (href.startsWith('http')) return false;
    
    const normalize = (p: any) => {
        if (!p || typeof p !== 'string') return '';
        let clean = p.split('?')[0].split('#')[0];
        clean = clean.replace(/\/index\.html$/, '');
        clean = clean.replace(/\/+$/, '');
        return clean || '/';
    };

    const currentPath = normalize(pathname);
    const targetPath = normalize(href);

    if (targetPath === '/') {
        return currentPath === '/' || currentPath === '';
    }

    return currentPath === targetPath;
  }, [pathname]);

  const isGroupActive = useCallback((items: { href: string }[]) => {
    if (!items || !Array.isArray(items)) return false;
    return items.some(item => isActive(item.href));
  }, [isActive]);

  const userHasAccess = useCallback((roles?: string[]) => {
    if (loading || !currentUser || !currentUser.role) return false;
    if (!roles) return true;
    return roles.includes(currentUser.role);
  }, [loading, currentUser]);

  useEffect(() => {
    if (hasMounted && !loading && pathname) {
      const activeGroups = navGroups
        .filter(g => g && isGroupActive(g.items) && userHasAccess(g.roles))
        .map(g => g.title);
      setOpenGroups(activeGroups);
    }
  }, [loading, pathname, userHasAccess, isGroupActive, hasMounted]);

  return (
    <div className="flex min-h-screen w-full flex-col">
      <header className="sticky top-0 flex h-16 items-center gap-4 border-b bg-background px-4 md:px-6 z-50">
        <nav className="hidden flex-col gap-6 text-lg font-medium md:flex md:flex-row md:items-center md:gap-5 md:text-sm lg:gap-6">
          <Link href={getHref('/')} className="flex items-center gap-2 text-lg font-semibold md:text-base">
            <Logo />
          </Link>
          <TopNav />
        </nav>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="shrink-0 md:hidden">
              <Menu className="h-5 w-5" />
              <span className="sr-only">Toggle navigation menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="p-0">
            <div className="flex h-full flex-col">
              <div className="p-6 border-b">
                 <Link href={getHref('/')} className="flex items-center gap-2 text-lg font-semibold">
                   <Logo />
                </Link>
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                <nav className="grid gap-2 text-lg font-medium">
                  <Link href={getHref('/')} className={cn("flex items-center gap-4 rounded-xl px-3 py-2 text-base", isActive('/') ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}>
                      Dashboard
                  </Link>
                   <Accordion type="multiple" className="w-full" value={openGroups} onValueChange={setOpenGroups}>
                      {loading ? (
                        Array.from({ length: 3 }).map((_, i) => (
                          <div key={i} className="flex items-center justify-between py-4 font-medium">
                              <Skeleton className="h-5 w-32" />
                          </div>
                        ))
                      ) : navGroups.map(group => (
                          group && userHasAccess(group.roles) ? (
                              <AccordionItem value={group.title} key={group.title} className="border-b-0">
                                  <AccordionTrigger className="py-2 text-base hover:no-underline text-muted-foreground hover:text-foreground [&[data-state=open]]:text-foreground">
                                      {group.title}
                                  </AccordionTrigger>
                                  <AccordionContent className="pl-4 pb-0">
                                      <div className="flex flex-col gap-1">
                                          {(group.items || []).filter(item => item && userHasAccess(item.roles)).map(item => (
                                              item.href.startsWith('http') ? (
                                                <a
                                                  key={item.href}
                                                  href={item.href}
                                                  target="_blank"
                                                  rel="noopener noreferrer"
                                                  onClick={(e) => { e.preventDefault(); openExternalLink(item.href); }}
                                                  className="block rounded-lg p-3 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                                                >
                                                  {item.label}
                                                </a>
                                              ) : (
                                                <Link 
                                                  key={item.href} 
                                                  href={getHref(item.href)} 
                                                  className={cn("block rounded-lg p-3 text-sm", isActive(item.href) ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
                                                >
                                                    {item.label}
                                                </Link>
                                              )
                                          ))}
                                      </div>
                                  </AccordionContent>
                              </AccordionItem>
                          ) : null
                      ))}
                  </Accordion>
                </nav>
              </div>
            </div>
          </SheetContent>
        </Sheet>
        <div className="flex w-full items-center gap-4 md:ml-auto md:gap-2 lg:gap-4">
            <div className="ml-auto flex-1 sm:initial" />
          <UserNav />
        </div>
      </header>
      <main className="flex flex-1 flex-col gap-4 p-4 md:gap-8 md:p-8">
        {children}
      </main>
    </div>
  );
}

