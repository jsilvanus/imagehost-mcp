import React, { useState } from 'react';
import { X, Info, Copy, Check, Terminal, Bot, Sparkles } from 'lucide-react';
import { appPath, getBrandName } from '../api';

interface InfoModalProps {
  onClose: () => void;
}

export const InfoModal: React.FC<InfoModalProps> = ({ onClose }) => {
  const [activeTab, setActiveTab] = useState<'mcp' | 'chatgpt'>('mcp');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const brandName = getBrandName();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const mcpUrl = `${origin}${appPath('/mcp')}`;
  const openApiUrl = `${origin}${appPath('/api/chatgpt/openapi.yaml')}`;

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  const claudeConfigSnippet = JSON.stringify(
    {
      mcpServers: {
        [brandName.toLowerCase()]: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  const gptInstructionsSnippet = `You are a creative visual assistant connected to the user's personal ${brandName} photo library.

Whenever you generate an image using DALL-E or when the user asks you to save a visual:
1. Immediately invoke the \`importChatGptImages\` action.
2. Provide the generated image in the \`openaiFileIdRefs\` parameter.
3. Provide a clear description and optional tags (all images will automatically receive the 'ai' and 'chatgpt' tags).
4. Once the action succeeds, present the resulting permanent URL to the user.
5. If the import fails, explain the error transparently and do not claim the image was archived.`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: '640px', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <div
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                background: 'rgba(59, 130, 246, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--accent-blue)',
              }}
            >
              <Info size={18} />
            </div>
            <div>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                Integrations & Setup
              </h2>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Connect {brandName} with MCP clients and ChatGPT
              </div>
            </div>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close dialog">
            <X size={18} />
          </button>
        </div>

        {/* Tab Switcher */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'var(--bg-secondary)',
          }}
        >
          <button
            onClick={() => setActiveTab('mcp')}
            style={{
              flex: 1,
              padding: '0.75rem 1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'mcp' ? '2px solid var(--accent-blue)' : '2px solid transparent',
              color: activeTab === 'mcp' ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: activeTab === 'mcp' ? 600 : 500,
              fontSize: '0.85rem',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <Terminal size={16} color={activeTab === 'mcp' ? 'var(--accent-blue)' : 'currentColor'} />
            Model Context Protocol (MCP)
          </button>
          <button
            onClick={() => setActiveTab('chatgpt')}
            style={{
              flex: 1,
              padding: '0.75rem 1rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'chatgpt' ? '2px solid var(--accent-blue)' : '2px solid transparent',
              color: activeTab === 'chatgpt' ? 'var(--text-primary)' : 'var(--text-muted)',
              fontWeight: activeTab === 'chatgpt' ? 600 : 500,
              fontSize: '0.85rem',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            <Bot size={16} color={activeTab === 'chatgpt' ? '#10b981' : 'currentColor'} />
            ChatGPT Actions
          </button>
        </div>

        {/* Body Content */}
        <div
          className="modal-body"
          style={{
            overflowY: 'auto',
            padding: '1.2rem',
            gap: '1.2rem',
          }}
        >
          {activeTab === 'mcp' ? (
            <>
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                  {brandName} natively supports the <strong>Model Context Protocol (MCP)</strong> with Streamable HTTP transport and OAuth 2.0 PKCE authentication. This lets coding assistants and AI agents (such as Claude Desktop, Cursor, Antigravity, or Claude Code) browse photo collections, search tags, and retrieve image derivatives.
                </p>
              </div>

              {/* MCP Endpoint Box */}
              <div
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem',
                }}
              >
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  MCP Server Endpoint
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <code style={{ fontSize: '0.85rem', color: 'var(--accent-blue)', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {mcpUrl}
                  </code>
                  <button
                    className="btn-icon"
                    onClick={() => copyToClipboard(mcpUrl, 'mcpUrl')}
                    title="Copy MCP URL"
                    style={{ flexShrink: 0 }}
                  >
                    {copiedKey === 'mcpUrl' ? <Check size={16} color="var(--success-green)" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>

              {/* Config snippet */}
              <div
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Claude Desktop / Cursor Config
                  </div>
                  <button
                    className="btn-icon"
                    onClick={() => copyToClipboard(claudeConfigSnippet, 'mcpConfig')}
                    title="Copy Config JSON"
                  >
                    {copiedKey === 'mcpConfig' ? <Check size={16} color="var(--success-green)" /> : <Copy size={16} />}
                  </button>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '0.6rem 0.8rem',
                    background: '#070a10',
                    borderRadius: '6px',
                    fontSize: '0.78rem',
                    color: '#e2e8f0',
                    overflowX: 'auto',
                    fontFamily: 'monospace',
                  }}
                >
                  {claudeConfigSnippet}
                </pre>
              </div>

              {/* Capabilities list */}
              <div>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>
                  Available MCP Tools:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {[
                    'list_groups',
                    'list_group_images',
                    'search_images',
                    'get_thumbnail_url',
                    'get_preview_url',
                    'get_original_url',
                    'request_image_deletion',
                    'batch_get_download_urls',
                  ].map((tool) => (
                    <span
                      key={tool}
                      style={{
                        fontSize: '0.72rem',
                        fontFamily: 'monospace',
                        background: 'var(--bg-elevated)',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '4px',
                        padding: '0.2rem 0.5rem',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                  Automatically archive DALL-E generated images and chat uploads from a ChatGPT Custom GPT directly into {brandName}. Stored images are organized into a <strong>ChatGPT</strong> group and automatically tagged with <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>ai</span> and <span style={{ color: 'var(--accent-blue)', fontWeight: 600 }}>chatgpt</span>.
                </p>
              </div>

              {/* OpenAPI URL Box */}
              <div
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem',
                }}
              >
                <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  OpenAPI 3.1 Specification URL
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <code style={{ fontSize: '0.85rem', color: '#10b981', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {openApiUrl}
                  </code>
                  <button
                    className="btn-icon"
                    onClick={() => copyToClipboard(openApiUrl, 'openApiUrl')}
                    title="Copy OpenAPI URL"
                    style={{ flexShrink: 0 }}
                  >
                    {copiedKey === 'openApiUrl' ? <Check size={16} color="var(--success-green)" /> : <Copy size={16} />}
                  </button>
                </div>
              </div>

              {/* Step-by-step instructions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                  How to setup in ChatGPT:
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    <span style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
                      1
                    </span>
                    <span>
                      In <strong>ChatGPT</strong>, open <strong>Explore GPTs</strong> &rarr; <strong>Create a GPT</strong> (or edit your existing Custom GPT). Under <strong>Capabilities</strong>, ensure <strong>DALL·E Image Generation</strong> is enabled.
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    <span style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
                      2
                    </span>
                    <span>
                      Scroll down to <strong>Actions</strong> &rarr; <strong>Create new action</strong>. Click <strong>Import from URL</strong>, paste the OpenAPI URL above, and click <strong>Import</strong>.
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '0.6rem' }}>
                    <span style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700, flexShrink: 0 }}>
                      3
                    </span>
                    <span>
                      Under <strong>Authentication</strong>, select <strong>API Key</strong>, choose Auth Type <strong>Bearer</strong>, and enter your server's <code style={{ color: 'var(--accent-blue)', background: 'rgba(59, 130, 246, 0.1)', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>CHATGPT_API_KEY</code> or your personal bearer token.
                    </span>
                  </div>
                </div>
              </div>

              {/* Instructions Prompt Snippet */}
              <div
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: '8px',
                  padding: '0.85rem 1rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Recommended GPT Instructions
                  </div>
                  <button
                    className="btn-icon"
                    onClick={() => copyToClipboard(gptInstructionsSnippet, 'gptInstructions')}
                    title="Copy Instructions Prompt"
                  >
                    {copiedKey === 'gptInstructions' ? <Check size={16} color="var(--success-green)" /> : <Copy size={16} />}
                  </button>
                </div>
                <pre
                  style={{
                    margin: 0,
                    padding: '0.6rem 0.8rem',
                    background: '#070a10',
                    borderRadius: '6px',
                    fontSize: '0.76rem',
                    color: '#e2e8f0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    maxHeight: '160px',
                    overflowY: 'auto',
                  }}
                >
                  {gptInstructionsSnippet}
                </pre>
              </div>

              {/* Automatic Tags Notice */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                  padding: '0.6rem 0.8rem',
                  borderRadius: '6px',
                  background: 'rgba(16, 185, 129, 0.1)',
                  border: '1px solid rgba(16, 185, 129, 0.25)',
                  fontSize: '0.8rem',
                  color: '#6ee7b7',
                }}
              >
                <Sparkles size={16} style={{ flexShrink: 0 }} />
                <span>
                  <strong>Automatic Tagging:</strong> All images imported through this action are automatically tagged with <code>ai</code> and <code>chatgpt</code> for instant search and filtering.
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
