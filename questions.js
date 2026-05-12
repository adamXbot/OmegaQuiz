// Phishing-focused quiz questions
// Used by server (for correctness checks) and host screen (for display)
const QUESTIONS = [
  {
    q: `An email arrives from <span class="mono">support@goog1e.com</span> asking you to verify your account. What's the biggest red flag?`,
    options: [
      "The email asks for verification",
      "The sender domain uses a '1' instead of an 'l'",
      "It came in the morning",
      "It mentions a real website"
    ],
    correct: 1,
    lesson: "Look-alike domains (goog1e.com vs google.com) are one of the most common phishing tricks. Always inspect the sender address character by character — attackers swap letters for similar-looking numbers or symbols."
  },
  {
    q: "Which of these is the SAFEST way to verify whether a 'Your package is held' email is legitimate?",
    options: [
      "Click the tracking link in the email",
      "Reply asking them to confirm",
      "Go directly to the courier's website and enter the tracking number yourself",
      "Forward it to your personal account first"
    ],
    correct: 2,
    lesson: "Never trust links inside suspicious emails. Always navigate to the real website yourself by typing the URL or using a bookmark. This bypasses any malicious link the attacker has embedded."
  },
  {
    q: "You receive a Microsoft 365 password-reset email — but you never requested one. What should you do?",
    options: [
      "Click the link to see what happens",
      "Reset your password just in case",
      "Ignore the email and reset your password through your usual login page if concerned",
      "Forward it to your whole team to warn them"
    ],
    correct: 2,
    lesson: "Unexpected password-reset emails are classic phishing bait. Don't click — log in directly through the official portal. If you didn't request it, the email itself is the suspicious event, not your password."
  },
  {
    q: `The CEO emails you at 4:55pm Friday: <em>"I'm in a meeting — urgently buy $500 in gift cards and send me the codes."</em> What's happening?`,
    options: [
      "A legitimate urgent request — act fast",
      "A test of your loyalty to leadership",
      "Business Email Compromise (BEC) — a phishing scam impersonating the CEO",
      "An IT system glitch"
    ],
    correct: 2,
    lesson: "Gift-card requests from executives are a hallmark of Business Email Compromise. Real executives don't pay for things with gift cards. Verify through a known channel (call them, walk over) before acting on any unusual financial request."
  },
  {
    q: "A phishing email's link shows <span class='mono'>company-portal.com</span> on screen — but hovering reveals it actually points to <span class='mono'>bit.ly/x9k2</span>. What's the lesson?",
    options: [
      "Shortened URLs are always safe",
      "Always hover over links before clicking to see the real destination",
      "Bit.ly links are official Microsoft links",
      "The displayed text is always the real link"
    ],
    correct: 1,
    lesson: "The visible text of a link can say anything — what matters is the actual URL. Hover (on desktop) or long-press (on mobile) to reveal the true destination before you ever click."
  },
  {
    q: "Which of these is NOT typically a phishing red flag?",
    options: [
      "Urgent language pressuring you to act now",
      "Unexpected attachments you didn't request",
      "Generic greetings like 'Dear Customer'",
      "An email signed by a colleague you spoke to earlier"
    ],
    correct: 3,
    lesson: "Urgency, unexpected attachments, and generic greetings are all classic phishing signs. An email from a colleague you've already been in contact with is generally legitimate — though always stay alert if its tone or request feels off."
  },
  {
    q: "You get a text message: <em>'AusPost: package undeliverable, pay $2.99 redelivery fee'</em> with a link. This is an example of…",
    options: [
      "Spear phishing",
      "Whaling",
      "Smishing (SMS phishing)",
      "Vishing"
    ],
    correct: 2,
    lesson: "SMS phishing is called 'smishing'. The small fee ($2.99) is bait — the real goal is harvesting your card details on the fake page that follows. Couriers never ask for redelivery payment via SMS link."
  },
  {
    q: "An email attachment is named <span class='mono'>Invoice.pdf.exe</span>. What does the double extension mean?",
    options: [
      "It's a PDF that runs faster",
      "It's actually an executable file disguised as a PDF — likely malware",
      "It's a compressed PDF",
      "It's a PDF with a digital signature"
    ],
    correct: 1,
    lesson: "Double extensions are a classic malware trick. Windows often hides the final extension, so 'Invoice.pdf.exe' may appear as just 'Invoice.pdf' — but it's an executable that will run code on your machine. Never open them."
  },
  {
    q: "You clicked a link in a suspicious email and entered your password before realising. What's the FIRST thing to do?",
    options: [
      "Hope nothing bad happens",
      "Delete the email so no one finds out",
      "Immediately change your password and report to IT/Security",
      "Wait to see if anything unusual happens to your account"
    ],
    correct: 2,
    lesson: "Speed matters. Change the password immediately (and anywhere else you used it), then report to IT. They can monitor for misuse, force re-authentication, and warn others. Hiding the mistake is worse than the mistake itself."
  },
  {
    q: "Which is the strongest defence against credential phishing succeeding, even if you do enter your password on a fake site?",
    options: [
      "Using a long password",
      "Multi-Factor Authentication (MFA)",
      "Changing your password every month",
      "Using the same password everywhere so it's easy to remember"
    ],
    correct: 1,
    lesson: "MFA is your safety net. Even if attackers steal your password, they can't log in without your second factor (app, key, or token). Turn it on for every account that supports it — it's the single highest-impact security habit."
  }
];

// Bonus/tiebreaker questions used if multiple players survive all 10
const BONUS_QUESTIONS = [
  {
    q: "What's the term for a phishing attack specifically targeting a high-profile individual like a CEO or CFO?",
    options: ["Spear phishing", "Whaling", "Pharming", "Clone phishing"],
    correct: 1,
    lesson: "Whaling targets the 'big fish' — executives whose credentials unlock major financial damage."
  },
  {
    q: "Which protocol, visible in the address bar, encrypts traffic to a website?",
    options: ["HTTP", "FTP", "HTTPS", "SMTP"],
    correct: 2,
    lesson: "HTTPS encrypts the connection — but note: phishing sites can also use HTTPS. The padlock alone doesn't mean safe."
  },
  {
    q: "What does the 'S' in SPF, used to validate email senders, stand for?",
    options: ["Secure", "Sender", "Server", "Signed"],
    correct: 1,
    lesson: "Sender Policy Framework lets domain owners specify which servers can send mail on their behalf — a key defence against spoofing."
  },
  {
    q: "An attacker creates a near-identical copy of a legitimate email you recently received, but swaps the link. What's this called?",
    options: ["Spear phishing", "Clone phishing", "Vishing", "Watering hole attack"],
    correct: 1,
    lesson: "Clone phishing exploits familiarity — you've seen the legit email, so the copy feels safe."
  },
  {
    q: "What's the best place to report a suspicious email at most organisations?",
    options: [
      "Reply to the sender asking if it's real",
      "Forward it to all your colleagues",
      "Use your email client's 'Report Phishing' button or forward to IT/Security",
      "Just delete it and move on"
    ],
    correct: 2,
    lesson: "Reporting helps the security team warn others and block the campaign — silent deletion lets it keep spreading."
  }
];

if (typeof module !== 'undefined') {
  module.exports = { QUESTIONS, BONUS_QUESTIONS };
}
