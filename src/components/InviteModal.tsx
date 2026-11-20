import React, { useMemo, useState } from 'react';
import {
  Check,
  Gamepad2,
  Loader2,
  Lock,
  LogIn,
  Play,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  UserPlus,
  Users,
  X
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';
import { ThemeConfig, THEMES } from '../services/themeStore';
import { AVATAR_PRESETS } from '../services/cloudSaveService';
import { auth } from '../services/firebase';
import { ARCADE_GAMES, ArcadeGameMeta, ArcadeGameType, getArcadeGameMeta } from '../utils/arcadeEngines';
import { createFirestoreChessRoom } from '../services/chessRoomService';
import { createFirestoreArcadeRoom } from '../services/arcadeRoomService';
import { cancelGameInvite, GameInvite, InviteGameKind, InviteGameType, sendGameInvite } from '../services/inviteService';
import { createChatMessageId, deriveFriendCode, isProfileOnlineNow, sendDirectMessage } from '../services/chatService';

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeTheme?: ThemeConfig;
  onOpenAccountModal: () => void;
}

interface InviteGameOption {
  gameKind: InviteGameKind;
  gameType: InviteGameType;
  gameTitle: string;
  emoji: string;
  category: string;
  subtitle: string;
}

interface InviteRecipient {
  uid: string;
  displayName: string;
  friendCode: string;
  avatarId: string;
  isFriend: boolean;
  isOnline: boolean;
}

const CHESS_OPTION: InviteGameOption = {
  gameKind: 'chess',
  gameType: 'chess',
  gameTitle: 'Chess',
  emoji: '♟️',
  category: 'Board',
  subtitle: 'Classic 1v1 strategy'
};

function getAvatarIcon(avatarId?: string | null): string {
  return (AVATAR_PRESETS.find(a => a.id === avatarId) || AVATAR_PRESETS[0]).icon;
}

export const InviteModal: React.FC<InviteModalProps> = ({
  isOpen,
  onClose,
  activeTheme = THEMES.original,
  onOpenAccountModal
}) => {
  const { user, profile, isSignedIn } = useAuth();
  const {
    contacts,
    directoryProfiles,
    incomingInvites,
    outgoingInvites,
    acceptGameInvite,
    declineGameInvite,
    openGameRoom,
    trackedChessRoom,
    trackedArcadeRoom
  } = useNotifications();

  const [selectedGameType, setSelectedGameType] = useState<InviteGameType>('chess');
  const [gameSearch, setGameSearch] = useState('');
  const [gameCategory, setGameCategory] = useState<string>('All');
  const [playerSearch, setPlayerSearch] = useState('');
  const [jumpOnSend, setJumpOnSend] = useState(true);
  const [reuseActiveRoom, setReuseActiveRoom] = useState(true);
  const [sendingToUid, setSendingToUid] = useState<string | null>(null);
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const myUid = auth.currentUser?.uid || user?.uid || '';
  const isFirebaseAuthenticated = Boolean(isSignedIn && myUid && auth.currentUser?.uid === myUid);
  const myDisplayName =
    profile?.displayName || user?.displayName || 'Player';
  const myAvatarId = profile?.avatarId || 'melon_classic';

  const allGameOptions = useMemo<InviteGameOption[]>(() => {
    const arcadeOpts: InviteGameOption[] = ARCADE_GAMES.map((g: ArcadeGameMeta) => ({
      gameKind: 'arcade',
      gameType: g.id,
      gameTitle: g.name,
      emoji: g.emoji,
      category: g.category || 'Arcade',
      subtitle: g.tagline
    }));
    return [CHESS_OPTION, ...arcadeOpts];
  }, []);

  const gameCategories = useMemo(() => {
    const set = new Set<string>(['All']);
    allGameOptions.forEach(opt => {
      if (opt.category) set.add(opt.category);
    });
    return Array.from(set);
  }, [allGameOptions]);

  const filteredGames = useMemo(() => {
    const q = gameSearch.trim().toLowerCase();
    return allGameOptions.filter(opt => {
      if (gameCategory !== 'All' && opt.category !== gameCategory) return false;
      if (!q) return true;
      return (
        opt.gameTitle.toLowerCase().includes(q) ||
        opt.category.toLowerCase().includes(q) ||
        opt.subtitle.toLowerCase().includes(q)
      );
    });
  }, [allGameOptions, gameCategory, gameSearch]);

  const selectedGame = useMemo(() => {
    if (selectedGameType === 'chess') return CHESS_OPTION;
    const meta = getArcadeGameMeta(selectedGameType as ArcadeGameType);
    return {
      gameKind: 'arcade' as const,
      gameType: meta.id,
      gameTitle: meta.name,
      emoji: meta.emoji,
      category: meta.category || 'Arcade',
      subtitle: meta.tagline
    };
  }, [selectedGameType]);

  const matchingActiveRoomCode = useMemo(() => {
    if (selectedGame.gameKind === 'chess') {
      return trackedChessRoom?.code || null;
    }
    if (trackedArcadeRoom && trackedArcadeRoom.gameType === selectedGame.gameType) {
      return trackedArcadeRoom.code;
    }
    return null;
  }, [selectedGame, trackedChessRoom, trackedArcadeRoom]);

  const recipients = useMemo<InviteRecipient[]>(() => {
    const map = new Map<string, InviteRecipient>();

    // Prioritize directory profiles so we know live online status & confirmed chatProfile existence
    const directoryMap = new Map(directoryProfiles.map(p => [p.userId, p]));

    for (const c of contacts) {
      if (!c.contactUid || c.contactUid === myUid) continue;
      const dir = directoryMap.get(c.contactUid);
      map.set(c.contactUid, {
        uid: c.contactUid,
        displayName: c.nickname || dir?.displayName || c.displayName || 'Friend',
        friendCode: c.friendCode || dir?.friendCode || deriveFriendCode(c.contactUid),
        avatarId: dir?.avatarId || c.avatarId || 'melon_classic',
        isFriend: true,
        isOnline: dir ? isProfileOnlineNow(dir) : false
      });
    }

    for (const dir of directoryProfiles) {
      if (!dir.userId || dir.userId === myUid) continue;
      if (!map.has(dir.userId)) {
        map.set(dir.userId, {
          uid: dir.userId,
          displayName: dir.displayName || 'Player',
          friendCode: dir.friendCode || deriveFriendCode(dir.userId),
          avatarId: dir.avatarId || 'melon_classic',
          isFriend: false,
          isOnline: isProfileOnlineNow(dir)
        });
      }
    }

    const q = playerSearch.trim().toLowerCase();
    return Array.from(map.values())
      .filter(p => {
        if (!q) return true;
        return (
          p.displayName.toLowerCase().includes(q) ||
          p.friendCode.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (a.isFriend !== b.isFriend) return a.isFriend ? -1 : 1;
        if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });
  }, [contacts, directoryProfiles, myUid, playerSearch]);

  if (!isOpen) return null;

  const accent = activeTheme.accent || '#10b981';
  const cardBg = activeTheme.bgCard || '#080f1d';
  const headerBg = activeTheme.bgHeader || '#040a14';
  const border = activeTheme.border || 'rgba(255,255,255,0.12)';

  const handleSendInvite = async (recipient: InviteRecipient) => {
    if (!isFirebaseAuthenticated) {
      setFeedback({ kind: 'error', text: 'Sign in with Google first to send game invites.' });
      return;
    }

    setFeedback(null);
    setSendingToUid(recipient.uid);
    try {
      let roomCode = reuseActiveRoom && matchingActiveRoomCode ? matchingActiveRoomCode : '';

      if (!roomCode) {
        if (selectedGame.gameKind === 'chess') {
          const created = await createFirestoreChessRoom({
            playerId: myUid,
            playerName: myDisplayName,
            preferredColor: 'w',
            timeControlId: 'none'
          });
          roomCode = created.code;
        } else {
          const created = await createFirestoreArcadeRoom({
            gameType: selectedGame.gameType as ArcadeGameType,
            playerId: myUid,
            playerName: myDisplayName,
            preferredSeat: 'p1'
          });
          roomCode = created.code;
        }
      }

      await sendGameInvite({
        fromUid: myUid,
        fromName: myDisplayName,
        fromAvatarId: myAvatarId,
        toUid: recipient.uid,
        toName: recipient.displayName,
        gameKind: selectedGame.gameKind,
        gameType: selectedGame.gameType,
        gameTitle: selectedGame.gameTitle,
        roomCode
      });

      // Notify recipient in chat as well (non-blocking if thread creation fails)
      void sendDirectMessage({
        myProfile: {
          userId: myUid,
          displayName: myDisplayName,
          avatarId: myAvatarId
        },
        targetProfile: {
          userId: recipient.uid,
          displayName: recipient.displayName,
          avatarId: recipient.avatarId
        },
        text: `🎮 Invited you to play ${selectedGame.gameTitle}! Tap Accept on your invite notification to join.`,
        clientMessageId: createChatMessageId()
      }).catch(() => {});

      setFeedback({
        kind: 'success',
        text: `Invited ${recipient.displayName} to ${selectedGame.gameTitle} (Room ${roomCode}).`
      });

      if (jumpOnSend) {
        openGameRoom(selectedGame.gameKind === 'chess' ? 'chess' : 'rooms', roomCode);
        onClose();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not send invite.';
      setFeedback({
        kind: 'error',
        text: msg.toLowerCase().includes('missing or insufficient permissions')
          ? `${recipient.displayName} needs to open Chatbox or sign in once before receiving direct invites.`
          : msg
      });
    } finally {
      setSendingToUid(null);
    }
  };

  const handleAcceptInvite = async (inv: GameInvite) => {
    await acceptGameInvite(inv);
    onClose();
  };

  const handleOpenSentRoom = (inv: GameInvite) => {
    openGameRoom(inv.gameKind === 'chess' ? 'chess' : 'rooms', inv.roomCode);
    onClose();
  };

  const handleCancelInvite = async (inviteId: string) => {
    setCancellingInviteId(inviteId);
    try {
      await cancelGameInvite(inviteId);
    } finally {
      setCancellingInviteId(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[65] bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] rounded-3xl border shadow-2xl flex flex-col overflow-hidden"
        style={{ backgroundColor: headerBg, borderColor: border }}
        onClick={e => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          className="px-5 py-4 border-b flex items-center justify-between gap-3 shrink-0"
          style={{ backgroundColor: cardBg, borderColor: border }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-2xl border flex items-center justify-center shrink-0"
              style={{
                backgroundColor: activeTheme.accentBadge || 'rgba(16, 185, 129, 0.15)',
                borderColor: activeTheme.borderActive || accent,
                color: accent
              }}
            >
              <Gamepad2 className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-extrabold text-white truncate">
                Game Invites · {ARCADE_GAMES.length + 1} Games
              </h2>
              <p className="text-[11px] text-slate-400 truncate">
                Challenge friends or online players to Chess or any multiplayer minigame — 1 click, no code needed.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 transition-colors cursor-pointer shrink-0"
            aria-label="Close invites modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 flex flex-col gap-5">
          {feedback && (
            <div
              className={`px-3.5 py-2.5 rounded-2xl border text-xs font-semibold flex items-center justify-between gap-2 ${
                feedback.kind === 'success'
                  ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                  : 'bg-rose-500/15 border-rose-400/40 text-rose-200'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles className="w-4 h-4 shrink-0" />
                <span className="break-words">{feedback.text}</span>
              </div>
              <button
                type="button"
                onClick={() => setFeedback(null)}
                className="text-current opacity-75 hover:opacity-100 cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Incoming Invites Section */}
          {incomingInvites.length > 0 && (
            <div className="rounded-2xl border border-sky-400/40 bg-sky-500/10 p-3.5 flex flex-col gap-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold uppercase tracking-wider text-sky-300 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Incoming Game Invites ({incomingInvites.length})</span>
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {incomingInvites.map(inv => (
                  <div
                    key={inv.id}
                    className="p-3 rounded-xl border border-sky-400/30 bg-black/30 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="text-xl shrink-0">{getAvatarIcon(inv.fromAvatarId)}</span>
                      <div className="min-w-0">
                        <div className="text-xs font-extrabold text-white truncate">
                          {inv.fromName} → {inv.gameTitle}
                        </div>
                        <div className="text-[10px] text-sky-200/80 font-mono">
                          Room {inv.roomCode} · Ready to play
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => void handleAcceptInvite(inv)}
                        className="px-3 py-1.5 rounded-lg bg-sky-400 hover:bg-sky-300 text-black font-extrabold text-[11px] flex items-center gap-1 cursor-pointer"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>Accept</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void declineGameInvite(inv)}
                        className="px-2 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 text-[11px] font-bold cursor-pointer"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Auth Gate if user isn't signed into Firebase */}
          {!isFirebaseAuthenticated ? (
            <div
              className="rounded-2xl border p-6 text-center flex flex-col items-center gap-3"
              style={{ backgroundColor: cardBg, borderColor: border }}
            >
              <div
                className="w-12 h-12 rounded-2xl border flex items-center justify-center"
                style={{
                  backgroundColor: activeTheme.accentBadge,
                  borderColor: activeTheme.borderActive,
                  color: accent
                }}
              >
                <Lock className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-extrabold text-white">Sign in with Google to Invite Friends</h3>
              <p className="text-xs text-slate-400 max-w-md">
                Direct game invites sync live through your signed-in account so friends can jump straight into your Chess or Minigame room.
              </p>
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAccountModal();
                }}
                className="px-5 py-2.5 rounded-xl font-extrabold text-xs text-black flex items-center gap-2 cursor-pointer shadow-lg hover:scale-105 transition-transform"
                style={{ backgroundColor: accent }}
              >
                <LogIn className="w-4 h-4" />
                <span>Sign In to Invite</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
              {/* Left Column: Pick Game */}
              <div
                className="lg:col-span-7 rounded-2xl border p-3.5 flex flex-col gap-3"
                style={{ backgroundColor: cardBg, borderColor: border }}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs font-extrabold uppercase tracking-wider text-slate-300">
                    1. Choose Game ({selectedGame.emoji} {selectedGame.gameTitle})
                  </span>
                  {matchingActiveRoomCode && (
                    <button
                      type="button"
                      onClick={() => setReuseActiveRoom(prev => !prev)}
                      className={`px-2.5 py-1 rounded-lg border text-[10px] font-bold flex items-center gap-1 cursor-pointer transition-colors ${
                        reuseActiveRoom
                          ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200'
                          : 'bg-white/5 border-white/10 text-slate-400'
                      }`}
                      title="Toggle between inviting to your currently open room or creating a new room"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>
                        {reuseActiveRoom
                          ? `Using Active Room ${matchingActiveRoomCode}`
                          : 'Creating New Room'}
                      </span>
                    </button>
                  )}
                </div>

                {/* Game Search & Category Filter */}
                <div className="flex flex-col gap-2">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={gameSearch}
                      onChange={e => setGameSearch(e.target.value)}
                      placeholder={`Search Chess & ${ARCADE_GAMES.length} minigames...`}
                      className="w-full pl-9 pr-3 py-2 rounded-xl border border-white/10 bg-black/40 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400"
                    />
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                    {gameCategories.map(cat => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setGameCategory(cat)}
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap border cursor-pointer transition-colors ${
                          gameCategory === cat
                            ? 'text-black font-extrabold'
                            : 'text-slate-300 bg-white/5 border-white/10 hover:bg-white/10'
                        }`}
                        style={
                          gameCategory === cat
                            ? { backgroundColor: accent, borderColor: accent }
                            : undefined
                        }
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Game Picker Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-72 overflow-y-auto pr-1">
                  {filteredGames.map(opt => {
                    const isSelected = opt.gameType === selectedGameType;
                    return (
                      <button
                        key={opt.gameType}
                        type="button"
                        onClick={() => setSelectedGameType(opt.gameType)}
                        className={`p-2.5 rounded-xl border text-left transition-all cursor-pointer flex items-center gap-2 ${
                          isSelected
                            ? 'shadow-md'
                            : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.07]'
                        }`}
                        style={
                          isSelected
                            ? {
                                backgroundColor: activeTheme.accentBadge || 'rgba(16, 185, 129, 0.16)',
                                borderColor: accent
                              }
                            : undefined
                        }
                      >
                        <span className="text-lg shrink-0">{opt.emoji}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-bold text-white truncate">{opt.gameTitle}</div>
                          <div className="text-[10px] text-slate-400 truncate">{opt.category}</div>
                        </div>
                        {isSelected && <Check className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} />}
                      </button>
                    );
                  })}
                  {filteredGames.length === 0 && (
                    <div className="col-span-full py-6 text-center text-xs text-slate-400">
                      No games match &ldquo;{gameSearch}&rdquo;.
                    </div>
                  )}
                </div>
              </div>

              {/* Right Column: Pick Friend / Online Player */}
              <div
                className="lg:col-span-5 rounded-2xl border p-3.5 flex flex-col gap-3"
                style={{ backgroundColor: cardBg, borderColor: border }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" style={{ color: accent }} />
                    <span>2. Invite Player ({recipients.length})</span>
                  </span>

                  <label className="flex items-center gap-1.5 text-[11px] text-slate-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={jumpOnSend}
                      onChange={e => setJumpOnSend(e.target.checked)}
                      className="accent-emerald-500 cursor-pointer"
                    />
                    <span>Open room</span>
                  </label>
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={playerSearch}
                    onChange={e => setPlayerSearch(e.target.value)}
                    placeholder="Filter friends or code..."
                    className="w-full pl-9 pr-3 py-2 rounded-xl border border-white/10 bg-black/40 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-400"
                  />
                </div>

                <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
                  {recipients.length === 0 ? (
                    <div className="py-8 px-4 text-center text-xs text-slate-400 rounded-xl border border-dashed border-white/10">
                      <UserPlus className="w-6 h-6 mx-auto mb-2 text-slate-500" />
                      No friends or online players found yet. Add friends in Chatbox or wait for players to sign in.
                    </div>
                  ) : (
                    recipients.map(person => {
                      const alreadyInvitedSameGame = outgoingInvites.some(
                        inv =>
                          inv.toUid === person.uid &&
                          inv.gameType === selectedGame.gameType &&
                          inv.status === 'pending'
                      );
                      const isSending = sendingToUid === person.uid;

                      return (
                        <div
                          key={person.uid}
                          className="p-2.5 rounded-xl border border-white/10 bg-black/25 flex items-center justify-between gap-2.5"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div className="relative text-lg shrink-0">
                              <span>{getAvatarIcon(person.avatarId)}</span>
                              {person.isOnline && (
                                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-[#080f1d]" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="text-xs font-bold text-white truncate flex items-center gap-1.5">
                                <span className="truncate">{person.displayName}</span>
                                {person.isFriend && (
                                  <span className="px-1.5 py-0.2 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-bold shrink-0">
                                    Friend
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400 flex items-center gap-1.5 font-mono">
                                <span>{person.isOnline ? 'Online' : 'Offline'}</span>
                                <span>·</span>
                                <span>{person.friendCode}</span>
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            disabled={Boolean(sendingToUid)}
                            onClick={() => void handleSendInvite(person)}
                            className="px-3 py-1.5 rounded-xl font-extrabold text-[11px] flex items-center gap-1.5 cursor-pointer transition-transform hover:scale-105 disabled:opacity-50 shrink-0 text-black"
                            style={{ backgroundColor: accent }}
                          >
                            {isSending ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Send className="w-3 h-3" />
                            )}
                            <span>{isSending ? 'Sending...' : alreadyInvitedSameGame ? 'Re-invite' : 'Invite'}</span>
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Outgoing Pending Invites */}
          {isFirebaseAuthenticated && outgoingInvites.length > 0 && (
            <div
              className="rounded-2xl border p-3.5 flex flex-col gap-2"
              style={{ backgroundColor: cardBg, borderColor: border }}
            >
              <span className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
                Sent Invites Waiting ({outgoingInvites.length})
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {outgoingInvites.map(inv => (
                  <div
                    key={inv.id}
                    className="p-2.5 rounded-xl border border-white/10 bg-black/25 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">
                        To {inv.toName} · {inv.gameTitle}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        Room {inv.roomCode} · Pending
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenSentRoom(inv)}
                        className="px-2.5 py-1 rounded-lg text-black font-extrabold text-[11px] cursor-pointer"
                        style={{ backgroundColor: accent }}
                      >
                        Join Room
                      </button>
                      <button
                        type="button"
                        disabled={cancellingInviteId === inv.id}
                        onClick={() => void handleCancelInvite(inv.id)}
                        className="px-2 py-1 rounded-lg bg-white/5 hover:bg-rose-500/20 text-slate-300 hover:text-rose-200 text-[11px] font-bold cursor-pointer disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
