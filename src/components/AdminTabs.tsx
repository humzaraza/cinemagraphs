'use client'

import { useState, type ReactNode } from 'react'

interface Tab {
  id: string
  label: string
  content: ReactNode
}

export default function AdminTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '')

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-cinema-border mb-8 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className="px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors relative"
            style={{
              color: active === tab.id ? '#C8A951' : '#888',
            }}
          >
            {tab.label}
            {active === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-cinema-gold" />
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tabs.map((tab) => (
        <div key={tab.id} style={{ display: active === tab.id ? 'block' : 'none' }}>
          {tab.content}
        </div>
      ))}
    </div>
  )
}
