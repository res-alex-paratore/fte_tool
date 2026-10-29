
'use client';

import { useState, useEffect } from 'react';
import type { TeamMember } from '@/types';
import { writeLog } from '@/lib/logger';
import { getFullName, getPersonId, normalizeHrRoster } from '@/lib/hr-roster';

export type CurrentUser = {
  id: string;
  name: string;
  email?: string;
  role: 'manager' | 'admin' | 'vp';
  title?: string;
  region?: 'HYD' | 'EMEA' | 'NAM' | 'Central';
  manager?: string;
  team?: string;
};

const placeholderUser: CurrentUser = { 
  id: '', 
  name: 'Guest', 
  title: '...', 
  role: 'manager' 
};

export function useCurrentUser() {
  const [currentUser, setCurrentUser] = useState<CurrentUser>(placeholderUser);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUser = async () => {
      setLoading(true);
      try {
        const impersonatedUserId = typeof window !== 'undefined' ? localStorage.getItem('impersonated_user_id') : null;
        
        if (impersonatedUserId) {
            const response = await fetch(`/data/v1/consolidated_hr_fte_report_view`);
            if (response.ok) {
                const allEmployees: TeamMember[] = normalizeHrRoster(await response.json());
                if (Array.isArray(allEmployees)) {
                    const impersonatedEmp = allEmployees.find(e => e && getPersonId(e) === impersonatedUserId);
                    if (impersonatedEmp) {
                        const impersonatedUser: CurrentUser = {
                            id: getPersonId(impersonatedEmp) || impersonatedUserId,
                            name: getFullName(impersonatedEmp) || 'Impersonated User',
                            title: impersonatedEmp.title || '',
                            role: 'manager'
                        };
                        setCurrentUser(impersonatedUser);
                        writeLog('useCurrentUser', 'info', 'User impersonation successful', { impersonatedUserId: impersonatedUser.id, name: impersonatedUser.name });
                        return;
                    }
                }
            }
            writeLog('useCurrentUser', 'warning', 'Impersonation failed, falling back to live user.', { impersonatedUserId });
        }
        
        const response = await fetch('/domo/users/v1/me');
        if (response.ok) {
            const liveUser = await response.json();
            if (liveUser && liveUser.id) {
                let role: 'manager' | 'admin' | 'vp' = 'manager';
                const userRoles = Array.isArray(liveUser.roles) 
                    ? liveUser.roles.map((r: any) => r && r.name).filter(Boolean) 
                    : [];

                if (userRoles.includes('Admin')) {
                  role = 'admin';
                } else if (userRoles.includes('Privileged')) {
                  role = 'vp';
                }
                
                setCurrentUser({
                    id: liveUser.id.toString(),
                    name: liveUser.displayName || 'User',
                    email: liveUser.emailAddress || liveUser.email || '',
                    title: liveUser.title || '',
                    role: role,
                });
            } else {
                throw new Error('Invalid user data returned from Domo');
            }
        } else {
             writeLog('useCurrentUser', 'info', 'Failed to fetch live user, using dev persona', { status: response.status });
            setCurrentUser({ 
                id: 'dev-admin', 
                name: 'Development Admin', 
                title: 'System Administrator', 
                role: 'admin' 
            });
        }
      } catch (error) {
        writeLog('useCurrentUser', 'error', 'Error fetching user, falling back to dev persona', error);
        setCurrentUser({ 
            id: 'dev-admin', 
            name: 'Development Admin', 
            title: 'System Administrator', 
            role: 'admin' 
        });
      } finally {
        setLoading(false);
      }
    }

    fetchUser();
  }, []);
  
  const isAdmin = currentUser.role === 'admin';
  const isVp = currentUser.role === 'vp';
  const isManager = currentUser.role === 'manager';

  return { currentUser, isAdmin, isVp, isManager, loading };
}
