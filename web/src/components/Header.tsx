import React from 'react';
import { Camera, FolderPlus, Search, LogOut, LogIn } from 'lucide-react';
import type { User } from '../types';

interface HeaderProps {
  user: User | null;
  onNewGroup: () => void;
  onOpenSearch: () => void;
  onLogout: () => void;
}

export const Header: React.FC<HeaderProps> = ({ user, onNewGroup, onOpenSearch, onLogout }) => {
  return (
    <header className="app-header">
      <div className="logo-area">
        <div className="logo-icon">
          <Camera size={18} />
        </div>
        <span className="logo-text">ImageHost</span>
      </div>

      <div className="header-actions">
        <button
          className="btn-icon"
          title="Search library"
          onClick={onOpenSearch}
          aria-label="Search"
        >
          <Search size={18} />
        </button>

        <button className="btn-primary" onClick={onNewGroup} title="Create New Group">
          <FolderPlus size={16} />
          <span style={{ display: 'none', minWidth: '40px' }} className="sm-inline">
            Group
          </span>
        </button>

        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span
              style={{
                fontSize: '0.8rem',
                color: 'var(--text-secondary)',
                maxWidth: '90px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={user.displayName || user.email}
            >
              {user.displayName || user.email?.split('@')[0] || 'User'}
            </span>
            <button className="btn-icon" onClick={onLogout} title="Sign Out" aria-label="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        ) : (
          <a
            href="/v1/auth/login"
            className="btn-icon"
            style={{ textDecoration: 'none' }}
            title="Sign In with Tunnus OIDC"
            aria-label="Sign in"
          >
            <LogIn size={16} />
          </a>
        )}
      </div>
    </header>
  );
};
