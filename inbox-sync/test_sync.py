import unittest
from sync import describe
class ContextTests(unittest.TestCase):
 def setUp(self):
  self.job=dict(id='a'*20,source='tips/2026-10-04_12-00-00_abcdefghijkl/_submission.json',generation='123',state='ready',revision=2,context_version=1,plan_context_version=1,updated='2026-10-04T12:00:00Z')
 def test_uses_existing_claude_title_and_description(self):
  p={'decision':'draft','story_title':'Bicycle riders in Monterey','headline':'BIKE RIDERS','instagram_description':'Tipster reports riders in Monterey.\n\nCredit: supplied footage','verification_notes':['private notes']}
  result=describe(self.job,p,{'receivedAt':'2026-10-04T11:00:00Z','submission':{'senderContact':'private'}})
  self.assertEqual(result['title'],p['story_title']);self.assertEqual(result['summary'],'Tipster reports riders in Monterey.');self.assertNotIn('private',str(result))
 def test_new_context_hides_old_claude_title_until_revised(self):
  self.job['plan_context_version']=0
  result=describe(self.job,{'decision':'draft','headline':'Old headline'},{})
  self.assertEqual(result['title'],'');self.assertEqual(result['contextSource'],'pending')
 def test_non_tip_fixture_is_excluded(self):
  self.job['source']='audit:fixture';self.assertIsNone(describe(self.job,{},{}))
 def test_declined_plan_is_not_a_report_title(self):
  result=describe(self.job,{'decision':'hold','headline':'Not approved'},{});self.assertEqual(result['title'],'')
if __name__=='__main__':unittest.main()
