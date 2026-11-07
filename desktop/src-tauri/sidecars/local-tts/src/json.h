// Minimal JSON for dial8-local-tts: parses protocol v1 messages and
// voices.json, and writes the few messages the sidecar sends. Not a general
// JSON library: no pretty-printing, numbers are doubles, object keys keep
// their order and the first of a duplicate wins.
#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <utility>
#include <vector>

namespace json {

struct Value {
    enum Type { Null, Bool, Number, String, Array, Object };
    Type type = Null;
    bool b = false;
    double n = 0;
    std::string s;
    std::vector<Value> items;                            // Array
    std::vector<std::pair<std::string, Value>> fields;   // Object

    const Value* get(const std::string& key) const {
        if (type != Object)
            return nullptr;
        for (const auto& f : fields)
            if (f.first == key)
                return &f.second;
        return nullptr;
    }
    std::string str(const std::string& key, const std::string& def = "") const {
        const Value* v = get(key);
        return v && v->type == String ? v->s : def;
    }
    double num(const std::string& key, double def) const {
        const Value* v = get(key);
        return v && v->type == Number ? v->n : def;
    }
    bool boolean(const std::string& key, bool def) const {
        const Value* v = get(key);
        return v && v->type == Bool ? v->b : def;
    }
};

namespace detail {

struct Parser {
    const char* p;
    const char* end;
    int depth = 0;

    void ws() {
        while (p < end && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r'))
            p++;
    }
    bool lit(const char* word) {
        const char* q = p;
        for (; *word; word++, q++)
            if (q >= end || *q != *word)
                return false;
        p = q;
        return true;
    }
    static void utf8(std::string& out, unsigned cp) {
        if (cp < 0x80) {
            out += char(cp);
        } else if (cp < 0x800) {
            out += char(0xC0 | (cp >> 6));
            out += char(0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            out += char(0xE0 | (cp >> 12));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        } else {
            out += char(0xF0 | (cp >> 18));
            out += char(0x80 | ((cp >> 12) & 0x3F));
            out += char(0x80 | ((cp >> 6) & 0x3F));
            out += char(0x80 | (cp & 0x3F));
        }
    }
    bool hex4(unsigned& cp) {
        if (end - p < 4)
            return false;
        cp = 0;
        for (int i = 0; i < 4; i++, p++) {
            const char c = *p;
            cp <<= 4;
            if (c >= '0' && c <= '9')
                cp |= unsigned(c - '0');
            else if (c >= 'a' && c <= 'f')
                cp |= unsigned(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F')
                cp |= unsigned(c - 'A' + 10);
            else
                return false;
        }
        return true;
    }
    bool string(std::string& out) {
        if (p >= end || *p != '"')
            return false;
        p++;
        while (p < end && *p != '"') {
            const unsigned char c = static_cast<unsigned char>(*p++);
            if (c < 0x20)
                return false;
            if (c != '\\') {
                out += char(c);
                continue;
            }
            if (p >= end)
                return false;
            switch (*p++) {
                case '"': out += '"'; break;
                case '\\': out += '\\'; break;
                case '/': out += '/'; break;
                case 'b': out += '\b'; break;
                case 'f': out += '\f'; break;
                case 'n': out += '\n'; break;
                case 'r': out += '\r'; break;
                case 't': out += '\t'; break;
                case 'u': {
                    unsigned cp;
                    if (!hex4(cp))
                        return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {  // surrogate pair
                        unsigned lo;
                        if (end - p < 2 || p[0] != '\\' || p[1] != 'u')
                            return false;
                        p += 2;
                        if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF)
                            return false;
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        return false;
                    }
                    // \u0000 is dropped: a NUL in a std::string would cut
                    // it short wherever it is passed on as a C string.
                    if (cp != 0)
                        utf8(out, cp);
                    break;
                }
                default: return false;
            }
        }
        if (p >= end)
            return false;
        p++;  // closing quote
        return true;
    }
    bool number(double& out) {
        const char* start = p;
        if (p < end && *p == '-')
            p++;
        while (p < end && ((*p >= '0' && *p <= '9') || *p == '.' || *p == 'e' || *p == 'E' || *p == '+' || *p == '-'))
            p++;
        if (p == start)
            return false;
        const std::string text(start, p);
        char* stop = nullptr;
        out = std::strtod(text.c_str(), &stop);  // the process locale is "C"
        return stop == text.c_str() + text.size() && std::isfinite(out);
    }
    bool value(Value& v) {
        if (++depth > 64)
            return false;
        ws();
        bool ok = false;
        if (p >= end) {
            ok = false;
        } else if (*p == '{') {
            v.type = Value::Object;
            p++;
            ws();
            if (p < end && *p == '}') {
                p++;
                ok = true;
            } else {
                for (;;) {
                    std::string key;
                    ws();
                    if (!string(key))
                        break;
                    ws();
                    if (p >= end || *p != ':')
                        break;
                    p++;
                    Value item;
                    if (!value(item))
                        break;
                    if (!v.get(key))
                        v.fields.emplace_back(std::move(key), std::move(item));
                    ws();
                    if (p < end && *p == ',') {
                        p++;
                        continue;
                    }
                    if (p < end && *p == '}') {
                        p++;
                        ok = true;
                    }
                    break;
                }
            }
        } else if (*p == '[') {
            v.type = Value::Array;
            p++;
            ws();
            if (p < end && *p == ']') {
                p++;
                ok = true;
            } else {
                for (;;) {
                    Value item;
                    if (!value(item))
                        break;
                    v.items.push_back(std::move(item));
                    ws();
                    if (p < end && *p == ',') {
                        p++;
                        continue;
                    }
                    if (p < end && *p == ']') {
                        p++;
                        ok = true;
                    }
                    break;
                }
            }
        } else if (*p == '"') {
            v.type = Value::String;
            ok = string(v.s);
        } else if (lit("true")) {
            v.type = Value::Bool;
            v.b = ok = true;
        } else if (lit("false")) {
            v.type = Value::Bool;
            ok = true;
        } else if (lit("null")) {
            ok = true;
        } else {
            v.type = Value::Number;
            ok = number(v.n);
        }
        depth--;
        return ok;
    }
};

}  // namespace detail

// false on malformed input (or trailing garbage).
inline bool
parse(const char* data, size_t size, Value& out) {
    detail::Parser ps{data, data + size};
    out = Value();
    if (!ps.value(out))
        return false;
    ps.ws();
    return ps.p == ps.end;
}

// A JSON string literal. Bytes >= 0x80 pass through (UTF-8 in, UTF-8 out).
inline std::string
quote(const std::string& s) {
    std::string out = "\"";
    for (const char ch : s) {
        const unsigned char c = static_cast<unsigned char>(ch);
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", c);
                    out += buf;
                } else {
                    out += ch;
                }
        }
    }
    return out + "\"";
}

// Builds one JSON object: Object().add("type", "ready").add("fatal", false).str()
class Object {
public:
    Object& add(const std::string& key, const std::string& v) { return raw(key, quote(v)); }
    Object& add(const std::string& key, const char* v) { return raw(key, quote(v)); }
    Object& add(const std::string& key, bool v) { return raw(key, v ? "true" : "false"); }
    Object& add(const std::string& key, int v) { return raw(key, std::to_string(v)); }
    Object& add(const std::string& key, double v) {
        if (!std::isfinite(v))
            return raw(key, "null");
        char buf[32];
        std::snprintf(buf, sizeof buf, "%.4f", v);
        return raw(key, buf);
    }
    Object& add(const std::string& key, const std::vector<std::string>& v) {
        std::string a = "[";
        for (size_t i = 0; i < v.size(); i++)
            a += (i ? "," : "") + quote(v[i]);
        return raw(key, a + "]");
    }
    Object& raw(const std::string& key, const std::string& json_text) {
        body_ += (body_.empty() ? "" : ",") + quote(key) + ":" + json_text;
        return *this;
    }
    std::string str() const { return "{" + body_ + "}"; }

private:
    std::string body_;
};

}  // namespace json
