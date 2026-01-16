import React, { useState } from 'react';
import { Copy, Check, Layout, Palette, Smartphone, Flame, Shield, Menu, Bell, User, ChevronRight } from 'lucide-react';

export default function BondfireApp() {
  const [activeTab, setActiveTab] = useState('palette');
  const [copiedColor, setCopiedColor] = useState(null);

  // Derived Color Palette
  const colors = {
    primary: {
      name: 'Bondfire Copper',
      hex: '#D97736',
      desc: 'Primary brand color. Used for CTAs, active states, and logo accents.'
    },
    primaryDark: {
      name: 'Deep Ember',
      hex: '#A04E24',
      desc: 'Darker shade of copper for gradients, borders, and pressed states.'
    },
    accent: {
      name: 'Molten Gold',
      hex: '#F0AB68',
      desc: 'Highlight color for gradients and specific illustrations.'
    },
    bg: {
      name: 'Obsidian',
      hex: '#141416',
      desc: 'Main application background. Deep, cool charcoal.'
    },
    surface: {
      name: 'Gunmetal',
      hex: '#1F2023',
      desc: 'Card and panel backgrounds. Slightly lighter than the base.'
    },
    border: {
      name: 'Iron',
      hex: '#33353A',
      desc: 'Borders and dividers. Subtle separation.'
    },
    textMain: {
      name: 'White Smoke',
      hex: '#F3F4F6',
      desc: 'Primary text color for maximum readability.'
    },
    textMuted: {
      name: 'Ash',
      hex: '#9CA3AF',
      desc: 'Secondary text, captions, and placeholders.'
    }
  };

  const copyToClipboard = (hex) => {
    // Fallback for iframe environments where navigator.clipboard might be restricted
    try {
        const textArea = document.createElement("textarea");
        textArea.value = hex;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setCopiedColor(hex);
        setTimeout(() => setCopiedColor(null), 2000);
    } catch (err) {
        console.error('Failed to copy', err);
    }
  };

  // --- Sub-Components ---

  const Navigation = () => (
    <nav className="flex space-x-1 bg-[#1F2023] p-1 rounded-xl mb-6 inline-flex border border-[#33353A]">
      <button
        onClick={() => setActiveTab('palette')}
        className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-all ${
          activeTab === 'palette' 
            ? 'bg-[#33353A] text-white shadow-sm' 
            : 'text-[#9CA3AF] hover:text-white'
        }`}
      >
        <Palette className="w-4 h-4 mr-2" />
        Palette
      </button>
      <button
        onClick={() => setActiveTab('components')}
        className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-all ${
          activeTab === 'components' 
            ? 'bg-[#33353A] text-white shadow-sm' 
            : 'text-[#9CA3AF] hover:text-white'
        }`}
      >
        <Layout className="w-4 h-4 mr-2" />
        UI Kit
      </button>
      <button
        onClick={() => setActiveTab('mockup')}
        className={`flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-all ${
          activeTab === 'mockup' 
            ? 'bg-[#33353A] text-white shadow-sm' 
            : 'text-[#9CA3AF] hover:text-white'
        }`}
      >
        <Smartphone className="w-4 h-4 mr-2" />
        App Mockup
      </button>
    </nav>
  );

  const PaletteView = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in fade-in zoom-in duration-500">
      {Object.values(colors).map((color) => (
        <div key={color.hex} className="group relative bg-[#1F2023] border border-[#33353A] rounded-2xl overflow-hidden hover:border-[#D97736] transition-colors duration-300 shadow-xl">
          <div 
            className="h-32 w-full transition-transform duration-500 group-hover:scale-105"
            style={{ backgroundColor: color.hex }}
          ></div>
          <div className="p-5">
            <h3 className="text-white font-bold text-lg mb-1">{color.name}</h3>
            <p className="text-[#9CA3AF] text-xs mb-4 h-8 leading-tight">{color.desc}</p>
            
            <button
              onClick={() => copyToClipboard(color.hex)}
              className="w-full flex items-center justify-between bg-[#141416] hover:bg-[#2A2B2E] border border-[#33353A] rounded-lg px-3 py-2 transition-colors group/btn"
            >
              <span className="text-gray-300 font-mono text-sm">{color.hex}</span>
              {copiedColor === color.hex ? (
                <Check className="w-4 h-4 text-green-500" />
              ) : (
                <Copy className="w-4 h-4 text-[#9CA3AF] group-hover/btn:text-white" />
              )}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const ComponentsView = () => (
    <div className="space-y-12 animate-in slide-in-from-bottom-4 duration-500">
      
      {/* Buttons */}
      <section>
        <h3 className="text-[#9CA3AF] text-xs font-bold uppercase tracking-wider mb-6">Buttons</h3>
        <div className="flex flex-wrap gap-4 items-center">
          {/* Primary */}
          <button className="bg-gradient-to-br from-[#D97736] to-[#A04E24] hover:brightness-110 text-white font-semibold py-3 px-6 rounded-xl shadow-[0_4px_14px_rgba(217,119,54,0.4)] transition-all transform hover:-translate-y-0.5 active:translate-y-0">
            Primary Action
          </button>
          
          {/* Secondary */}
          <button className="bg-[#33353A] hover:bg-[#3E4045] text-white font-semibold py-3 px-6 rounded-xl border border-transparent hover:border-[#D97736] transition-all">
            Secondary Action
          </button>
          
          {/* Ghost */}
          <button className="text-[#D97736] hover:text-[#F0AB68] font-semibold py-3 px-6 rounded-xl transition-colors">
            Text Link
          </button>

          {/* Icon Button */}
          <button className="bg-[#1F2023] p-3 rounded-full border border-[#33353A] text-[#9CA3AF] hover:text-[#D97736] hover:border-[#D97736] transition-all">
            <Shield className="w-5 h-5" />
          </button>
        </div>
      </section>

      {/* Cards */}
      <section>
        <h3 className="text-[#9CA3AF] text-xs font-bold uppercase tracking-wider mb-6">Cards & Containers</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Standard Card */}
          <div className="bg-[#1F2023] border border-[#33353A] rounded-2xl p-6">
            <div className="w-10 h-10 rounded-full bg-[#33353A] flex items-center justify-center mb-4 text-[#D97736]">
              <Flame className="w-5 h-5 fill-current" />
            </div>
            <h4 className="text-white font-bold text-lg mb-2">Standard Card</h4>
            <p className="text-[#9CA3AF] text-sm leading-relaxed">
              Used for general content. The background is subtle (#1F2023) to distinguish from the main background.
            </p>
          </div>

          {/* Active/Highlight Card */}
          <div className="bg-[#1F2023] border border-[#D97736] rounded-2xl p-6 relative overflow-hidden group cursor-pointer">
            <div className="absolute top-0 right-0 w-24 h-24 bg-[#D97736] opacity-10 blur-2xl rounded-full -mr-10 -mt-10 transition-opacity group-hover:opacity-20"></div>
            <div className="flex justify-between items-start mb-4">
               <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#D97736] to-[#A04E24] flex items-center justify-center text-white shadow-lg">
                <Shield className="w-5 h-5" />
              </div>
              <span className="bg-[#D97736]/20 text-[#D97736] text-xs font-bold px-2 py-1 rounded-md border border-[#D97736]/20">Active</span>
            </div>
           
            <h4 className="text-white font-bold text-lg mb-2">Selected State</h4>
            <p className="text-[#9CA3AF] text-sm leading-relaxed">
              Uses the primary copper color for the border and accents to indicate selection or high importance.
            </p>
          </div>

        </div>
      </section>

       {/* Form Elements */}
       <section>
        <h3 className="text-[#9CA3AF] text-xs font-bold uppercase tracking-wider mb-6">Inputs & Controls</h3>
        <div className="max-w-md space-y-4 bg-[#1F2023] p-6 rounded-2xl border border-[#33353A]">
          <div>
            <label className="block text-xs font-bold text-[#9CA3AF] mb-2 uppercase">Username</label>
            <input 
              type="text" 
              placeholder="Enter username"
              className="w-full bg-[#141416] text-white border border-[#33353A] rounded-xl px-4 py-3 focus:outline-none focus:border-[#D97736] focus:ring-1 focus:ring-[#D97736] transition-all placeholder-[#52525B]"
            />
          </div>
          
          <div className="flex items-center space-x-3">
            <div className="w-12 h-6 bg-[#33353A] rounded-full relative cursor-pointer">
                <div className="absolute right-1 top-1 w-4 h-4 bg-[#D97736] rounded-full shadow-sm"></div>
            </div>
            <span className="text-white text-sm">Notifications Enabled</span>
          </div>
        </div>
      </section>
    </div>
  );

  const MockupView = () => (
    <div className="flex justify-center py-4 animate-in fade-in zoom-in duration-500">
      <div className="w-[375px] h-[760px] bg-[#141416] rounded-[3rem] border-[8px] border-[#2A2B2E] shadow-2xl overflow-hidden relative flex flex-col">
        
        {/* Status Bar Mock */}
        <div className="h-12 w-full flex justify-between items-end px-6 pb-2">
            <span className="text-white text-xs font-bold">9:41</span>
            <div className="flex space-x-1">
                <div className="w-4 h-2.5 bg-white rounded-[1px]"></div>
                <div className="w-0.5 h-2.5 bg-white/30 rounded-[1px]"></div>
            </div>
        </div>

        {/* Header */}
        <div className="px-6 py-4 flex justify-between items-center">
            <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#D97736] to-[#A04E24] flex items-center justify-center text-white">
                    <Flame className="w-5 h-5 fill-white" />
                </div>
                <span className="text-white font-bold text-xl tracking-tight">Bondfire</span>
            </div>
            <div className="w-10 h-10 rounded-full bg-[#1F2023] border border-[#33353A] flex items-center justify-center text-[#9CA3AF] relative">
                <Bell className="w-5 h-5" />
                <div className="absolute top-2 right-2.5 w-2 h-2 bg-[#D97736] rounded-full border-2 border-[#1F2023]"></div>
            </div>
        </div>

        {/* Main Content Scroll */}
        <div className="flex-1 overflow-y-auto px-6 pb-20 scrollbar-hide">
            
            {/* Welcome */}
            <div className="mb-8 mt-2">
                <h1 className="text-3xl text-white font-bold leading-tight mb-2">
                    Ignite your <br/>
                    <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#D97736] to-[#F0AB68]">Potential</span>
                </h1>
                <p className="text-[#9CA3AF]">Your daily streak is on fire!</p>
            </div>

            {/* Featured Card */}
            <div className="bg-gradient-to-br from-[#D97736] to-[#A04E24] rounded-2xl p-6 text-white mb-8 shadow-lg relative overflow-hidden">
                <div className="absolute top-0 right-0 w-32 h-32 bg-white opacity-10 rounded-full -mr-10 -mt-10 blur-xl"></div>
                <div className="relative z-10">
                    <div className="flex justify-between items-start mb-8">
                        <div className="bg-white/20 backdrop-blur-sm p-2 rounded-lg">
                            <Shield className="w-6 h-6" />
                        </div>
                        <span className="text-xs font-bold bg-white/20 px-2 py-1 rounded">PRO</span>
                    </div>
                    <h3 className="text-xl font-bold mb-1">Premium Protection</h3>
                    <p className="text-orange-100 text-sm mb-4 opacity-90">Your shield is active until Nov 24.</p>
                    <button className="bg-white text-[#A04E24] px-4 py-2 rounded-lg text-sm font-bold w-full">View Details</button>
                </div>
            </div>

            {/* List */}
            <h3 className="text-white font-bold text-lg mb-4">Recent Activity</h3>
            <div className="space-y-4">
                {[1, 2, 3].map((item) => (
                    <div key={item} className="flex items-center p-4 bg-[#1F2023] border border-[#33353A] rounded-2xl hover:border-[#D97736] transition-colors cursor-pointer group">
                        <div className="w-12 h-12 rounded-full bg-[#141416] border border-[#33353A] flex items-center justify-center text-[#D97736] mr-4 group-hover:bg-[#D97736] group-hover:text-white transition-colors">
                            <Flame className="w-5 h-5" />
                        </div>
                        <div className="flex-1">
                            <h4 className="text-white font-semibold">Bonding Session</h4>
                            <p className="text-[#9CA3AF] text-xs">2 hours ago</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-[#33353A] group-hover:text-white" />
                    </div>
                ))}
            </div>

        </div>

        {/* Bottom Nav */}
        <div className="absolute bottom-0 w-full bg-[#1F2023]/90 backdrop-blur-lg border-t border-[#33353A] px-6 py-4 flex justify-between items-center">
             <div className="text-[#D97736] flex flex-col items-center">
                <Flame className="w-6 h-6 fill-current mb-1" />
                <span className="text-[10px] font-bold">Home</span>
             </div>
             <div className="text-[#9CA3AF] flex flex-col items-center">
                <Layout className="w-6 h-6 mb-1" />
                <span className="text-[10px] font-medium">Feed</span>
             </div>
             <div className="text-[#9CA3AF] flex flex-col items-center">
                <User className="w-6 h-6 mb-1" />
                <span className="text-[10px] font-medium">Profile</span>
             </div>
        </div>

      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#141416] text-[#F3F4F6] font-sans p-6 md:p-12">
      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <header className="mb-12 flex flex-col md:flex-row md:items-end justify-between border-b border-[#33353A] pb-8">
          <div>
            <div className="flex items-center gap-3 mb-2">
               <div className="bg-gradient-to-br from-[#D97736] to-[#A04E24] p-2 rounded-lg">
                <Flame className="w-8 h-8 text-white fill-white" />
               </div>
               <h1 className="text-4xl font-extrabold tracking-tight text-white">Bondfire</h1>
            </div>
            <p className="text-[#9CA3AF] max-w-lg mt-2 text-lg">
              Design System & Color Identity
            </p>
          </div>
          <div className="mt-4 md:mt-0 text-right">
             <div className="text-xs font-mono text-[#D97736] bg-[#D97736]/10 px-3 py-1 rounded-full inline-block border border-[#D97736]/20">
                v1.0.0 • Dark Mode Native
             </div>
          </div>
        </header>

        <Navigation />

        <main className="min-h-[600px]">
          {activeTab === 'palette' && <PaletteView />}
          {activeTab === 'components' && <ComponentsView />}
          {activeTab === 'mockup' && <MockupView />}
        </main>

        <footer className="mt-20 border-t border-[#33353A] pt-8 text-center text-[#52525B] text-sm">
          <p>Generated for Bondfire • Use pure hex codes for best results across platforms.</p>
        </footer>
      </div>
    </div>
  );
}