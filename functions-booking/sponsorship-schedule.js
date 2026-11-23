'use strict';
const {fail}=require('./sponsorship-core');
const MINUTE=60000;
function localParts(value,timeZone){
    if(!Number.isFinite(new Date(value).getTime()))fail('Use a valid date and time.');
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function localDate(value,timeZone){const p=localParts(value,timeZone);return `${p.year}-${p.month}-${p.day}`;}
function localTimeToUtc(date,time,timeZone){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))fail('Use a valid date and time.');
    const target=Date.parse(`${date}T${time}:00Z`);if(!Number.isFinite(target)||new Date(target).toISOString().slice(0,10)!==date)fail('Use a valid date and time.');let result=target;
    for(let i=0;i<3;i++){const p=localParts(result,timeZone);result+=target-Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`);}
    const matches=v=>{const p=localParts(v,timeZone);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`===`${date} ${time}`;};
    // Reject missing and repeated DST wall times rather than choosing silently.
    if(!matches(result)||matches(result+3600000)||matches(result-3600000))fail('This time is ambiguous or unavailable because of daylight saving time.');
    return result;
}
const overlaps=(a,b)=>a.start<b.end&&a.end>b.start;
// Input is the filming date in the booking calendar's time zone.
function isFilmingHoliday(date) {
    const noon = Date.parse(date + 'T12:00:00Z');
    const day = new Date(noon).getUTCDay();
    const fixedDates = ['01-01', '06-19', '07-04', '11-11', '12-25'];
    const monthDay = date.slice(5);
    if (fixedDates.includes(monthDay)) return true;
    // Friday observes a Saturday holiday, Monday observes a Sunday holiday.
    const offset = day === 5 ? 1 : day === 1 ? -1 : 0;
    if (offset && fixedDates.includes(new Date(noon + offset * 86400000).toISOString().slice(5, 10))) return true;
    const month = Number(date.slice(5, 7));
    const dom = Number(date.slice(8));
    const week = Math.ceil(dom / 7);
    if (day === 4 && month === 11 && week === 4) return true; // Thanksgiving
    if (day !== 1) return false;
    return ((month === 1 || month === 2) && week === 3)
        || (month === 5 && dom >= 25)
        || (month === 9 && week === 1)
        || (month === 10 && week === 2);
}
function windowsFor(config,date){
    if (isFilmingHoliday(date)) return [];
    const override=config.windows.find(w=>w.date===date);
    if(override)return override.closed?[]:[override];
    if(config.availabilityMode==='dates')return [];
    const day=new Date(date+'T12:00:00Z').getUTCDay();
    return (config.weeklyWindows||[]).filter(w=>w.day===day).map(w=>({...w,date}));
}
function latestStart(windowEnd, videoPackage) {
    return videoPackage.windowEndIsLatestStart ? windowEnd : windowEnd - videoPackage.durationMinutes * MINUTE;
}
function offeredDates(config,now){
    const first=localDate(now,config.timeZone),dates=[];
    const packages=(config.packages?.length?config.packages:[config.package]).filter(Boolean);
    const earliest=now+config.leadHours*3600000;
    for(let i=0;i<(config.bookingHorizonDays||60);i++){
        const date=new Date(Date.parse(first+'T12:00:00Z')+i*86400000).toISOString().slice(0,10);
        if(windowsFor(config,date).some(w=>{
            const start=localTimeToUtc(date,w.start,config.timeZone),end=localTimeToUtc(date,w.end,config.timeZone);
            return packages.some(pack => latestStart(end, pack) >= Math.max(start, earliest));
        }))dates.push(date);
    }
    return dates;
}
function slotInterval(slot){return {start:Date.parse(slot.start)-slot.bufferBefore*MINUTE,end:Date.parse(slot.end)+slot.bufferAfter*MINUTE};}
function buildSlots(config,date,busy,holds,now=Date.now(),ignoreId=''){
    if(!config.package) return [];
    if(!Array.isArray(busy))fail('Calendar availability could not be checked.',503);
    const duration=config.package.durationMinutes,slots=[];
    for(const window of windowsFor(config,date)){
        const start=localTimeToUtc(date,window.start,config.timeZone),end=localTimeToUtc(date,window.end,config.timeZone);
        const cutoff = latestStart(end, config.package);
        for(let at=start;at<=cutoff;at+=30*MINUTE){
            if(at<now+config.leadHours*3600000)continue;
            const slot={start:new Date(at).toISOString(),end:new Date(at+duration*MINUTE).toISOString(),timeZone:config.timeZone,bufferBefore:config.bufferBefore,bufferAfter:config.bufferAfter};
            const range=slotInterval(slot);
            if(busy.some(b=>overlaps(range,b))||Object.entries(holds).some(([id,h])=>id!==ignoreId&&overlaps(range,slotInterval(h))))continue;
            if(!slots.some(s=>s.start===slot.start))slots.push(slot);
        }
    }
    return slots.sort((a,b)=>a.start.localeCompare(b.start));
}
function validateWindows(windows,timeZone){
    if(!Array.isArray(windows)||windows.length>120)fail('Provide up to 120 filming windows.');
    if(new Set(windows.map(w=>w?.date)).size!==windows.length)fail('Use one filming window per date. Calendar events can block breaks within that window.');
    return windows.map(w=>{
        if(w.closed===true){localTimeToUtc(w.date,'12:00',timeZone);return {date:w.date,closed:true};}
        const start=localTimeToUtc(w.date,w.start,timeZone),end=localTimeToUtc(w.date,w.end,timeZone);
        if(end<=start||end-start>16*3600000)fail('A filming window must end after it starts, within 16 hours.');
        return {date:w.date,start:w.start,end:w.end};
    });
}
function validateWeekly(windows){
    if(!Array.isArray(windows)||windows.length>7)fail('Use one weekly filming window per weekday.');
    if(new Set(windows.map(w=>w?.day)).size!==windows.length)fail('Use one weekly filming window per weekday.');
    return windows.map(w=>{
        if(!Number.isInteger(w.day)||w.day<0||w.day>6||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)||w.end<=w.start)fail('Check weekly filming hours.');
        return {day:w.day,start:w.start,end:w.end};
    });
}
module.exports={localDate,localTimeToUtc,slotInterval,overlaps,windowsFor,offeredDates,buildSlots,validateWindows,validateWeekly};
