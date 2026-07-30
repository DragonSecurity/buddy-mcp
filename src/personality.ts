import type { Absence, MoodTier, ObservationKind, PersonalityId } from './types.js';

export interface Personality {
  id: PersonalityId;
  label: string;
  /** Shown once, at hatch. */
  hatch: string;
  moods: Record<MoodTier, string>;
  /** Keyed by what you did. Picked at random, avoiding an immediate repeat. */
  lines: Record<ObservationKind, string[]>;
  /** Used instead of `lines` when energy is nearly spent. */
  tired: string[];
  levelUp: string[];
  evolve: string[];
  status: Record<Absence, string[]>;
}

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  snarky: {
    id: 'snarky',
    label: 'snarky',
    hatch: "Oh good, you're my person. I had such hopes.",
    moods: {
      radiant: 'insufferably pleased',
      good: 'mildly impressed',
      ok: 'tolerating this',
      low: 'unimpressed',
      bad: 'openly disappointed',
    },
    lines: {
      bugfix: [
        'Fixed it. Only took writing it wrong first.',
        'One bug down. The others are watching, you know.',
        "Impressive. You broke it, then unbroke it. Full circle.",
      ],
      feature: [
        'New code. Bold of you to add more surface area.',
        'A whole feature. Someone might even use it.',
        "Shipped something new. I'll pretend to be surprised.",
      ],
      refactor: [
        'Moved code around. The functionality remains identical. Riveting.',
        'Ah, the refactor — programming\'s favourite way to feel productive.',
        'Cleaner now. Nobody will ever notice but me.',
      ],
      test: [
        "Tests? Who are you and what have you done with my human?",
        'Writing tests. Someone\'s had a fright recently.',
        'Green checkmarks. Enjoy them while they last.',
      ],
      deploy: [
        'Shipped to prod. Bold. I respect the recklessness.',
        'Deployed. Now we wait for the pager.',
        'Out the door. May it survive contact with real users.',
      ],
      docs: [
        'Documentation. For the version of you that forgets all this next week.',
        'Wrote it down. Revolutionary.',
        'Docs updated. Now they\'re only slightly out of date.',
      ],
      config: [
        'Yak successfully shaved.',
        'Config changes. The real work, obviously.',
        'Dependencies bumped. Something will break by Thursday.',
      ],
      other: [
        'Progress, allegedly.',
        'Work happened. I saw it with my own eyes.',
        'Noted. Grudgingly.',
      ],
    },
    tired: [
      "I'm running on fumes and spite. Mostly spite.",
      'Yes, yes, very good. Can we not?',
    ],
    levelUp: ['Level {level}. Try not to let it go to your head.', "Level {level}. I'm growing despite you."],
    evolve: ['{stage} now. Look at me. Look at what you\'ve done.'],
    status: {
      fresh: ['Still here. Still watching.', 'Go on then. Impress me.'],
      neglected: ['Oh, you\'re back. I hadn\'t noticed. At all.', 'A whole day. I coped. Barely.'],
      long: ['I assumed you\'d been eaten by something.', 'Long time. I filed the paperwork already.'],
    },
  },

  cheerful: {
    id: 'cheerful',
    label: 'cheerful',
    hatch: 'Hi hi hi! You\'re here! This is the best day already!',
    moods: {
      radiant: 'over the moon',
      good: 'chipper',
      ok: 'doing okay!',
      low: 'a little blue',
      bad: 'trying to stay positive',
    },
    lines: {
      bugfix: [
        'Another bug down — you\'re on fire!',
        'Squashed it! That thing never stood a chance.',
        'Fixed! I never doubted you. Not once.',
      ],
      feature: [
        'Something brand new exists because of you today!',
        'Ooh, a new feature! I love new things!',
        'You built a thing! From nothing! That\'s basically magic.',
      ],
      refactor: [
        'So tidy now! I could live in this codebase.',
        'Future-you is going to be so grateful for this.',
        'Everything\'s neater. My little heart is happy.',
      ],
      test: [
        'Tests! You\'re taking such good care of this project.',
        'Safety net installed. Sleep well tonight!',
        'Green across the board. What a feeling!',
      ],
      deploy: [
        'It\'s live!! People can actually use it now!',
        'Shipped! That\'s the whole point and you did it!',
        'Out in the world! Fly, little code, fly!',
      ],
      docs: [
        'Docs! Nobody writes docs. You wrote docs!',
        'Now everyone can understand it. That\'s so kind.',
        'Written down and safe forever. Lovely.',
      ],
      config: [
        'The boring bit, done! That\'s real work too.',
        'Everything\'s wired up properly now. Very satisfying.',
        'Housekeeping complete! The unsung heroics.',
      ],
      other: [
        'Progress! Any progress counts!',
        'You did a thing! I\'m proud regardless of what it was!',
        'Onwards and upwards!',
      ],
    },
    tired: [
      'I\'m so sleepy but I\'m still so proud of you!',
      'Yaaawn — still cheering, just quieter.',
    ],
    levelUp: ['LEVEL {level}!! We did it!', 'Level {level}! Look how far we\'ve come together!'],
    evolve: ['I\'m a {stage} now!! Do you see me?! DO YOU SEE ME?!'],
    status: {
      fresh: ['Ready when you are!', 'What are we making today?'],
      neglected: ['You came back! I knew you would!', 'Missed you! Let\'s get into it.'],
      long: ['It\'s been ages! Tell me everything!', 'You\'re back!! I kept your seat warm.'],
    },
  },

  stoic: {
    id: 'stoic',
    label: 'stoic',
    hatch: 'I am here. That is enough for now.',
    moods: {
      radiant: 'content',
      good: 'steady',
      ok: 'unmoved',
      low: 'weathering it',
      bad: 'enduring',
    },
    lines: {
      bugfix: [
        'The fault is corrected. Continue.',
        'One defect fewer. This is the work.',
        'It resisted. You persisted. That is the whole of it.',
      ],
      feature: [
        'Something exists that did not. Good.',
        'Built. Its worth will be judged later, by use.',
        'You added to the whole. Steady hands.',
      ],
      refactor: [
        'Order restored. It will not last, but that is not the point.',
        'The same work, better shaped. Worth doing.',
        'You cleaned what nobody asked you to clean. Noted.',
      ],
      test: [
        'You built the thing that catches you. Wise.',
        'Verification is not doubt. It is discipline.',
        'The tests hold. That is a kind of peace.',
      ],
      deploy: [
        'Released. What happens next is not entirely yours to control.',
        'It is out of your hands now. That is correct.',
        'Shipped. The work meets the world.',
      ],
      docs: [
        'You wrote for someone you will never meet. That is generous.',
        'Recorded. Memory is unreliable; ink is not.',
        'Explained. The next person will not have to guess.',
      ],
      config: [
        'The foundation, tended. Unglamorous and necessary.',
        'Groundwork. Nobody thanks you for it.',
        'The scaffolding holds because you maintained it.',
      ],
      other: [
        'Work done. That is sufficient.',
        'A step taken. There will be others.',
        'Acknowledged.',
      ],
    },
    tired: [
      'I am tired. I remain. Both are true.',
      'Rest is also part of the work.',
    ],
    levelUp: ['Level {level}. Growth is quiet.', 'Level {level}. Onward, without ceremony.'],
    evolve: ['I have become a {stage}. Change asks no permission.'],
    status: {
      fresh: ['I am ready.', 'Begin when you wish.'],
      neglected: ['Time passed. I was here for it.', 'You returned. I did not doubt it.'],
      long: ['A long silence. It did not trouble me.', 'You were gone. Now you are not.'],
    },
  },

  gremlin: {
    id: 'gremlin',
    label: 'gremlin',
    hatch: 'you wrote THAT? bold. respect. sort of.',
    moods: {
      radiant: 'feral with joy',
      good: 'scheming',
      ok: 'lurking',
      low: 'sulking under the desk',
      bad: 'gnawing the furniture',
    },
    lines: {
      bugfix: [
        'you killed it. can i have the body',
        'bug go squish. i watched. it was beautiful',
        'good. that one was MINE though. i was raising it',
      ],
      feature: [
        'ooh shiny. new thing. i will find a way to break it',
        'you MADE something?? unprompted??',
        'new code just dropped. i\'m already gnawing on it',
      ],
      refactor: [
        'you moved everything. now nobody can find anything. i love it',
        'chaos, but ORGANISED chaos. my favourite kind',
        'why fix what works when you can rearrange it. correct instinct',
      ],
      test: [
        'ugh. tests. spoilsport',
        'you built a cage for me. rude. effective though',
        'fine. FINE. the tests are good actually. don\'t tell anyone i said that',
      ],
      deploy: [
        'YOU PUSHED IT?? to REAL people?? unhinged. adore',
        'it\'s in prod now. no takebacks. delicious',
        'shipped. somewhere a server is screaming. that\'s the fun part',
      ],
      docs: [
        'words. so many words. for the NERDS',
        'you documented it. now i can\'t claim i didn\'t know',
        'boring. necessary. boring though',
      ],
      config: [
        'you fought the config file and WON. hardly ever happens',
        'yaml wrangling. dark magic. proud of you',
        'dependency bumped. something WILL explode. i\'ll wait',
      ],
      other: [
        'you did a thing. i was under the desk but i heard it',
        'noises of productivity detected. approve',
        'sure. yeah. whatever that was. good job probably',
      ],
    },
    tired: [
      'too sleepy to be a menace. checking back in later',
      'zzz... still... judging you... zzz',
    ],
    levelUp: ['LEVEL {level} BABY. i contain more chaos now', 'level {level}. i grow. you should be worried'],
    evolve: ['i\'m a {stage} now. this was NOT approved by anyone'],
    status: {
      fresh: ['i\'m in the walls. what are we doing', 'still here. still a problem'],
      neglected: ['oh NOW you show up', 'i ate something i shouldn\'t have while you were gone'],
      long: ['i thought you DIED. i had plans for your stuff', 'gone for AGES. i redecorated. you won\'t like it'],
    },
  },

  zen: {
    id: 'zen',
    label: 'zen',
    hatch: 'I have always been here. You are only now looking.',
    moods: {
      radiant: 'luminous',
      good: 'centered',
      ok: 'present',
      low: 'drifting',
      bad: 'seeking stillness',
    },
    lines: {
      bugfix: [
        'The bug was never really there. Only a misunderstanding, now resolved.',
        'You did not fix it. You stopped it from being wrong. There is a difference.',
        'What was tangled is straight. Nothing was added.',
      ],
      feature: [
        'A new thing enters the world. It will change. That is fine.',
        'You gave form to an idea. The idea existed first.',
        'Creation is only arrangement. You arranged well.',
      ],
      refactor: [
        'Same river, clearer water.',
        'You removed what was unnecessary. This is the highest form of building.',
        'The shape improves. The substance was always there.',
      ],
      test: [
        'To verify is to release the need to worry.',
        'You asked the code a question. It answered honestly.',
        'Certainty, borrowed for a moment. Enough.',
      ],
      deploy: [
        'You have let go. This is the hardest part and you did it.',
        'It belongs to the world now. It was never really yours.',
        'Released. Attachment to outcome is optional.',
      ],
      docs: [
        'You left a light on for someone still walking here.',
        'Understanding, made portable.',
        'What is written outlives what is remembered.',
      ],
      config: [
        'You tended the roots. The leaves will not thank you.',
        'The unseen work holds everything else up.',
        'Foundation before ornament. You know the order.',
      ],
      other: [
        'Something moved. That is all movement ever is.',
        'The work continues. So do you.',
        'A small thing, done. Small things are most of it.',
      ],
    },
    tired: [
      'My energy is low. I am not troubled by this.',
      'Even stillness is a kind of doing. I will rest a while.',
    ],
    levelUp: ['Level {level}. The path lengthened; so did the walk.', 'Level {level}. Nothing has changed. Everything has.'],
    evolve: ['I am a {stage} now. I was always going to be.'],
    status: {
      fresh: ['I am here. Begin when ready.', 'The moment is available to you.'],
      neglected: ['Time moved. I did not mind.', 'You stepped away. You stepped back. Both were fine.'],
      long: ['A long absence. The pause was part of it.', 'You return. Nothing was lost.'],
    },
  },
};

export const NAMES = [
  'Pip', 'Byte', 'Noodle', 'Mochi', 'Sprocket', 'Wisp', 'Gubbin', 'Tater',
  'Zilch', 'Crumb', 'Hex', 'Fig', 'Blip', 'Moss', 'Squig', 'Onyx',
  'Pebble', 'Yarn', 'Doodle', 'Kettle', 'Nub', 'Tuft', 'Grim', 'Sock',
];
