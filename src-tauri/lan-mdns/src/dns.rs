//! The few DNS message shapes mDNS / DNS-SD needs (RFC 1035, 6762, 6763):
//! a PTR question for the service, and an answer with PTR, SRV and TXT.
//! Parsing is bounded: names are at most 255 bytes, compression pointers may
//! only point backwards, and a message is at most 9000 bytes (RFC 6762 §17).

pub const TYPE_A: u16 = 1;
pub const TYPE_PTR: u16 = 12;
pub const TYPE_TXT: u16 = 16;
pub const TYPE_SRV: u16 = 33;
pub const TYPE_ANY: u16 = 255;
pub const CLASS_IN: u16 = 1;
/// The top bit of a question's class: "unicast response, please" (RFC 6762 §5.4).
pub const QU_BIT: u16 = 0x8000;
/// The top bit of a record's class in an answer: "cache flush" (RFC 6762 §10.2).
pub const CACHE_FLUSH: u16 = 0x8000;
pub const MAX_MESSAGE: usize = 9000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub name: String,
    pub qtype: u16,
    pub unicast: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RData {
    Ptr(String),
    Srv { priority: u16, weight: u16, port: u16, target: String },
    Txt(Vec<String>),
    A([u8; 4]),
    Other(u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub name: String,
    pub ttl: u32,
    pub data: RData,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Message {
    pub id: u16,
    pub response: bool,
    pub questions: Vec<Question>,
    /// Answers, authority and additional records, in that order.
    pub records: Vec<Record>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ParseError(pub &'static str);

/* ─── Writing ─────────────────────────────────────────────────────────── */

fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}

/// A name as labels, uncompressed. Labels over 63 bytes are refused (the caller's names are short and ASCII).
pub fn put_name(out: &mut Vec<u8>, name: &str) -> Result<(), ParseError> {
    let trimmed = name.trim_end_matches('.');
    if trimmed.len() > 253 {
        return Err(ParseError("name too long"));
    }
    for label in trimmed.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(ParseError("bad label"));
        }
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    Ok(())
}

pub fn encode(m: &Message) -> Result<Vec<u8>, ParseError> {
    let mut out = Vec::with_capacity(512);
    put_u16(&mut out, m.id);
    // A response: QR and AA set (RFC 6762 §18.4); a query: all zero.
    put_u16(&mut out, if m.response { 0x8400 } else { 0 });
    put_u16(&mut out, m.questions.len() as u16);
    put_u16(&mut out, m.records.len() as u16);
    put_u16(&mut out, 0);
    put_u16(&mut out, 0);
    for q in &m.questions {
        put_name(&mut out, &q.name)?;
        put_u16(&mut out, q.qtype);
        put_u16(&mut out, CLASS_IN | if q.unicast { QU_BIT } else { 0 });
    }
    for r in &m.records {
        put_name(&mut out, &r.name)?;
        let (rtype, flush) = match &r.data {
            RData::Ptr(_) => (TYPE_PTR, false),
            RData::Srv { .. } => (TYPE_SRV, true),
            RData::Txt(_) => (TYPE_TXT, true),
            RData::A(_) => (TYPE_A, true),
            RData::Other(t) => (*t, false),
        };
        put_u16(&mut out, rtype);
        put_u16(&mut out, CLASS_IN | if flush { CACHE_FLUSH } else { 0 });
        out.extend_from_slice(&r.ttl.to_be_bytes());
        let mut rd = Vec::new();
        match &r.data {
            RData::Ptr(n) => put_name(&mut rd, n)?,
            RData::Srv { priority, weight, port, target } => {
                put_u16(&mut rd, *priority);
                put_u16(&mut rd, *weight);
                put_u16(&mut rd, *port);
                put_name(&mut rd, target)?;
            }
            RData::Txt(items) => {
                if items.is_empty() {
                    rd.push(0);
                }
                for t in items {
                    if t.len() > 255 {
                        return Err(ParseError("txt item too long"));
                    }
                    rd.push(t.len() as u8);
                    rd.extend_from_slice(t.as_bytes());
                }
            }
            RData::A(ip) => rd.extend_from_slice(ip),
            RData::Other(_) => {}
        }
        put_u16(&mut out, rd.len() as u16);
        out.extend_from_slice(&rd);
    }
    if out.len() > MAX_MESSAGE {
        return Err(ParseError("message too long"));
    }
    Ok(out)
}

/* ─── Reading ─────────────────────────────────────────────────────────── */

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, ParseError> {
        let v = *self.b.get(self.at).ok_or(ParseError("truncated"))?;
        self.at += 1;
        Ok(v)
    }
    fn u16(&mut self) -> Result<u16, ParseError> {
        Ok(((self.u8()? as u16) << 8) | self.u8()? as u16)
    }
    fn u32(&mut self) -> Result<u32, ParseError> {
        Ok(((self.u16()? as u32) << 16) | self.u16()? as u32)
    }
    fn bytes(&mut self, n: usize) -> Result<&'a [u8], ParseError> {
        let end = self.at.checked_add(n).ok_or(ParseError("truncated"))?;
        let s = self.b.get(self.at..end).ok_or(ParseError("truncated"))?;
        self.at = end;
        Ok(s)
    }
    /// A name, following compression pointers backwards only (so a loop can't form).
    fn name(&mut self) -> Result<String, ParseError> {
        let mut labels: Vec<String> = Vec::new();
        let mut pos = self.at;
        let mut jumped = false;
        let mut total = 0usize;
        loop {
            let len = *self.b.get(pos).ok_or(ParseError("truncated"))? as usize;
            if len & 0xc0 == 0xc0 {
                let lo = *self.b.get(pos + 1).ok_or(ParseError("truncated"))? as usize;
                let target = ((len & 0x3f) << 8) | lo;
                if target >= pos {
                    return Err(ParseError("forward pointer"));
                }
                if !jumped {
                    self.at = pos + 2;
                    jumped = true;
                }
                pos = target;
                continue;
            }
            if len & 0xc0 != 0 {
                return Err(ParseError("bad label type"));
            }
            if len == 0 {
                if !jumped {
                    self.at = pos + 1;
                }
                break;
            }
            let label = self.b.get(pos + 1..pos + 1 + len).ok_or(ParseError("truncated"))?;
            total += len + 1;
            if total > 255 {
                return Err(ParseError("name too long"));
            }
            labels.push(String::from_utf8_lossy(label).into_owned());
            pos += 1 + len;
        }
        Ok(labels.join("."))
    }
}

pub fn decode(b: &[u8]) -> Result<Message, ParseError> {
    if b.len() > MAX_MESSAGE {
        return Err(ParseError("message too long"));
    }
    let mut r = Reader { b, at: 0 };
    let id = r.u16()?;
    let flags = r.u16()?;
    let qd = r.u16()? as usize;
    let counts = [r.u16()? as usize, r.u16()? as usize, r.u16()? as usize];
    let mut m = Message { id, response: flags & 0x8000 != 0, ..Default::default() };
    for _ in 0..qd {
        let name = r.name()?;
        let qtype = r.u16()?;
        let class = r.u16()?;
        m.questions.push(Question { name, qtype, unicast: class & QU_BIT != 0 });
    }
    for _ in 0..counts.iter().sum::<usize>() {
        let name = r.name()?;
        let rtype = r.u16()?;
        let _class = r.u16()?;
        let ttl = r.u32()?;
        let len = r.u16()? as usize;
        let start = r.at;
        let end = start.checked_add(len).filter(|e| *e <= b.len()).ok_or(ParseError("truncated"))?;
        let data = match rtype {
            TYPE_PTR => RData::Ptr(r.name()?),
            TYPE_SRV => {
                let priority = r.u16()?;
                let weight = r.u16()?;
                let port = r.u16()?;
                RData::Srv { priority, weight, port, target: r.name()? }
            }
            TYPE_TXT => {
                let mut items = Vec::new();
                while r.at < end {
                    let n = r.u8()? as usize;
                    if r.at + n > end {
                        return Err(ParseError("txt overrun"));
                    }
                    let s = r.bytes(n)?;
                    if n > 0 {
                        items.push(String::from_utf8_lossy(s).into_owned());
                    }
                }
                RData::Txt(items)
            }
            TYPE_A if len == 4 => {
                let s = r.bytes(4)?;
                RData::A([s[0], s[1], s[2], s[3]])
            }
            other => RData::Other(other),
        };
        if r.at > end {
            return Err(ParseError("rdata overrun"));
        }
        r.at = end;
        m.records.push(Record { name, ttl, data });
    }
    Ok(m)
}

/// Names compare without case and without a trailing dot (RFC 6762 §16).
pub fn same_name(a: &str, b: &str) -> bool {
    a.trim_end_matches('.').eq_ignore_ascii_case(b.trim_end_matches('.'))
}
