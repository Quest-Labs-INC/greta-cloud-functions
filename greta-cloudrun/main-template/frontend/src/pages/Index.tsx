import { useState, useEffect, useRef } from "react";
import { Loader2, Sparkles } from "lucide-react";

const Index = () => {
  const [progress, setProgress] = useState(0);
  const [loadingText, setLoadingText] = useState("Initializing autonomous agent protocols...");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Canvas Neural Network Effect
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let particles: Array<{ x: number; y: number; vx: number; vy: number; size: number }> = [];

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      initParticles();
    };

    const initParticles = () => {
      particles = [];
      const particleCount = Math.floor((window.innerWidth * window.innerHeight) / 15000); // Responsive density
      for (let i = 0; i < particleCount; i++) {
        particles.push({
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.8, // Speed
          vy: (Math.random() - 0.5) * 0.8,
          size: Math.random() * 1.5 + 0.5,
        });
      }
    };

    const drawParticles = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      ctx.lineWidth = 0.5;

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        
        // Move
        p.x += p.vx;
        p.y += p.vy;

        // Bounce
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

        // Draw particle
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();

        // Connect particles
        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dx = p.x - p2.x;
          const dy = p.y - p2.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 120) {
            ctx.beginPath();
            ctx.strokeStyle = `rgba(255, 255, 255, ${0.2 * (1 - dist / 120)})`;
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
      }
      animationFrameId = requestAnimationFrame(drawParticles);
    };

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
    drawParticles();

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      cancelAnimationFrame(animationFrameId);
    };
  }, []);

  // Timer Logic
  useEffect(() => {
    const duration = 90000; 
    const startTime = Date.now();

    const phases = [
      { time: 0, text: "Initializing autonomous agent protocols..." },
      { time: 10000, text: "Structuring neural pathways..." },
      { time: 25000, text: "Ingesting project context..." },
      { time: 40000, text: "Calibrating development environment..." },
      { time: 55000, text: "Provisioning virtual workspace..." },
      { time: 70000, text: "Synthesizing architectural blueprints..." },
      { time: 80000, text: "Finalizing cognitive boot sequence..." },
      { time: 85000, text: "Agent ready. Handshake imminent..." },
    ];

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const newProgress = Math.min((elapsed / duration) * 100, 99.9);
      setProgress(newProgress);

      const currentPhase = [...phases].reverse().find((p) => elapsed >= p.time);
      if (currentPhase) {
        setLoadingText(currentPhase.text);
      }

      if (elapsed >= duration) {
        clearInterval(interval);
        setProgress(100);
        setLoadingText("System Online.");
      }
    }, 100);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white p-4 font-sans overflow-hidden relative selection:bg-white/20">
      
      {/* Canvas Background */}
      <canvas 
        ref={canvasRef} 
        className="absolute inset-0 z-0 opacity-40 pointer-events-none"
      />
      
      {/* Subtle vignettes to keep focus on center */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,black_100%)] z-0 pointer-events-none" />

      <div className="max-w-md w-full space-y-16 flex flex-col items-center relative z-10">
        
        {/* Animated Core */}
        <div className="relative flex items-center justify-center group mt-8">
          <div className="absolute inset-[-20%] border border-neutral-700/30 rounded-full animate-[spin_10s_linear_infinite]" />
          <div className="absolute inset-[-40%] border border-neutral-800/30 rounded-full animate-[spin_15s_linear_infinite_reverse]" />
          
          <div className="absolute inset-0 bg-white/5 rounded-full blur-2xl animate-pulse duration-1000" />
          
          <div className="relative bg-black border border-neutral-800 p-6 rounded-full shadow-[0_0_30px_-5px_rgba(255,255,255,0.15)] transition-all duration-700">
            <img 
              src="https://media-manager-c.questera.ai/greta-media/a82d46baad788cfac770e191944228d9a0cfc7a602dde7be66cdc121710e14b5d98183d1a2888432bc9f21dfb726db64/images/aW1hZ2UvcG5n/ef00b138898e0a6a67dc247093999a6f.png" 
              alt="Greta Agent Icon" 
              className="w-16 h-16 -ml-[2px] object-contain animate-pulse transition-all duration-500" 
            />
          </div>
          
          <Sparkles className="absolute -top-6 -right-6 w-8 h-8 text-neutral-500 animate-bounce delay-300" />
        </div>

        {/* Typography */}
        <div className="text-center space-y-6 w-full">
          <div className="space-y-2">
            <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-white pb-2 drop-shadow-lg">
              Greta OS
            </h1>
            <p className="text-neutral-500 font-medium tracking-[0.2em] text-xs uppercase">
              Autonomous Developer Agent
            </p>
          </div>
          
          <div className="h-8 flex items-center justify-center gap-3 text-neutral-300 font-medium bg-black/50 py-2 px-6 rounded-full border border-neutral-800 backdrop-blur-md w-max mx-auto shadow-inner">
            <Loader2 className="w-4 h-4 animate-spin text-white" />
            <span className="animate-pulse text-sm font-mono">{loadingText}</span>
          </div>
        </div>

        {/* Progress Section */}
        <div className="w-full space-y-4 px-2">
          <div className="relative h-1 w-full bg-neutral-900 rounded-full overflow-hidden border border-neutral-800">
            <div 
              className="absolute top-0 left-0 h-full bg-white rounded-full transition-all duration-100 ease-linear shadow-[0_0_15px_rgba(255,255,255,0.8)]"
              style={{ width: `${progress}%` }}
            >
              <div className="absolute inset-0 bg-white/30 w-full animate-[shimmer_2s_infinite]" />
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-neutral-500 font-mono tracking-wider uppercase px-1">
            <span>System Boot</span>
            <span className="text-white">{progress.toFixed(1)}%</span>
          </div>
        </div>
        
      </div>
    </div>
  );
};

export default Index;